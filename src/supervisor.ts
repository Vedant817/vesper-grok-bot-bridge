import { createHash } from 'node:crypto';
import type { Worker, Reasoner } from './contracts.js';
import { classifyPermission, Redactor, RedactedRecords } from './safety.js';
import { Memory } from './memory.js';
import { verifyWorktree, changes } from './worktree.js';

export interface Verification { passed: boolean; output: string }
export interface RunConfig { cwd: string; goal: string; maxTurns?: number; maxEvents?: number; timeoutMs?: number; signal?: AbortSignal }
export interface RunResult { state: 'completed' | 'stopped' | 'failed'; reason: string; turns: number }
export class Supervisor {
  constructor(private readonly worker: Worker, private readonly reasoner: Reasoner, private readonly memory: Memory, private readonly verify: (cwd: string, signal: AbortSignal) => Promise<Verification>, private readonly redactor = new Redactor()) {}
  async run(config: RunConfig): Promise<RunResult> {
    const maxTurns = config.maxTurns ?? 5, maxEvents = config.maxEvents ?? 500, timeout = config.timeoutMs ?? 600000;
    for (const n of [maxTurns, maxEvents, timeout]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Run limits must be positive integers');
    await verifyWorktree(config.cwd);
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(config.signal ? [config.signal] : [])]);
    const race = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Aborted'));
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    let turns = 0;
    const seen = new Map<string, number>();
    const stream = new RedactedRecords(this.redactor);
    try {
      const goal = this.redactor.redact(config.goal);
      await this.memory.append({ goal, initialRepository: await changes(config.cwd) });
      await race(this.worker.start(config.cwd, goal));
      for (let events = 0; events < maxEvents; events++) {
        const event = await race(this.worker.next(signal));
        if (event.type === 'output') {
          for (const line of stream.push(event.text)) await this.memory.append({ type: 'output', text: line });
          continue;
        }
        await this.memory.append(event);
        if (event.type === 'failed') return { state: 'failed', reason: this.redactor.redact(event.error), turns };
        if (event.type === 'permission') {
          const decision = classifyPermission(event.request, config.cwd);
          await this.memory.append({ permission: event.id, decision });
          await race(this.worker.respond(event.id, { allow: decision.allow }));
        } else if (event.type === 'question') {
          if (/\b(?:approv\w*|permission|credential\w*|password|payment|refund|force.push|delete|token|api.key)\b/i.test(event.question + ' ' + (event.options ?? []).join(' '))) return { state: 'stopped', reason: 'Approval-shaped question requires a structured permission contract', turns };
          const key = createHash('sha256').update(event.question).digest('hex');
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (seen.get(key)! > 2) return { state: 'stopped', reason: 'Repeated question loop', turns };
          const answer = await race(this.reasoner.answer(this.redactor.redact(event.question), this.memory.context(), event.options?.map(o => this.redactor.redact(o)), signal));
          await race(this.worker.respond(event.id, { allow: false, answer: this.redactor.redact(answer) }));
        } else {
          turns++;
          const proof = await race(this.verify(config.cwd, signal));
          const diff = await changes(config.cwd);
          const evidence = this.redactor.redact(JSON.stringify({ summary: event.summary, verification: proof, diff }));
          await this.memory.append({ evidence });
          const judgement = await race(this.reasoner.evaluate(this.redactor.redact(config.goal), evidence, signal));
          if (proof.passed && judgement.accept) return { state: 'completed', reason: this.redactor.redact(judgement.feedback), turns };
          const fingerprint = createHash('sha256').update(JSON.stringify({ diff, passed: proof.passed, output: proof.output })).digest('hex');
          seen.set(fingerprint, (seen.get(fingerprint) ?? 0) + 1);
          if (turns >= maxTurns || seen.get(fingerprint)! > 1) return { state: 'stopped', reason: 'Turn limit or unchanged failing evidence', turns };
          await race(this.worker.steer(this.redactor.redact(`Verification passed: ${proof.passed}. ${judgement.feedback}\n${proof.output.slice(0, 6000)}`)));
        }
      }
      return { state: 'stopped', reason: 'Event limit reached', turns };
    } catch (error) { return { state: 'failed', reason: this.redactor.redact(String(error)), turns }; }
    finally {
      // Cleanup has its own deadline because the run signal may already be aborted.
      await Promise.race([this.worker.cancel().catch(() => {}), new Promise<void>(r => { const t = setTimeout(r, 2000); t.unref(); })]);
      await Promise.race([this.worker.close().catch(() => {}), new Promise<void>(r => { const t = setTimeout(r, 2000); t.unref(); })]);
    }
  }
}
