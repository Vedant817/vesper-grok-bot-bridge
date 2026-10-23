import type { IPty } from 'node-pty';
import type { Worker, WorkerEvent } from '../contracts.js';
import { AsyncQueue, childEnvironment } from '../rpc.js';
import { Redactor, RedactedRecords } from '../safety.js';

/** Terminal output cannot reliably distinguish quoted instructions from prompts.
 * Approval-shaped text stops the process; no keystroke can grant permission. */
export class PtyWorker implements Worker {
  private process?: IPty;
  private queue = new AsyncQueue<WorkerEvent>();
  private text = '';
  private stopping = false;
  constructor(private readonly executable: string, private readonly args: string[], private readonly redactor: Redactor, private readonly env?: Record<string, string>) {}
  async start(cwd: string, task: string): Promise<void> {
    const pty = await import('node-pty').catch(() => { throw new Error('Optional node-pty unavailable; install native build prerequisites or use a structured adapter'); });
    const records = new RedactedRecords(this.redactor);
    this.process = pty.spawn(this.executable, this.args.map(a => a.replaceAll('{task}', task)), { cwd, env: childEnvironment(this.env) as Record<string, string>, name: 'xterm-256color', cols: 120, rows: 30 });
    this.process.onData(data => {
      if (this.stopping) return;
      const clean = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      this.text = (this.text + clean).slice(-8192);
      for (const line of records.push(clean)) this.queue.push({ type: 'output', text: line });
      if (/(?:\[(?:y\/n|Y\/n|y\/N)\]|allow.{0,40}\?|approve.{0,40}\?|permission|password:|press enter|continue\?)/i.test(this.text)) {
        this.stop();
        this.queue.push({ type: 'failed', error: 'Interactive terminal prompt detected; structured adapter required for a trustworthy response' });
      }
    });
    this.process.onExit(({ exitCode }) => {
      this.process = undefined;
      const tail = records.end(); if (tail) this.queue.push({ type: 'output', text: tail });
      if (!this.stopping) this.queue.push(exitCode === 0 ? { type: 'completed', summary: 'CLI exited with code 0' } : { type: 'failed', error: `CLI exited ${exitCode}` });
    });
  }
  next(signal: AbortSignal): Promise<WorkerEvent> { return this.queue.next(signal); }
  async respond(): Promise<void> { throw new Error('Unstructured terminal responses are disabled'); }
  async steer(): Promise<void> { throw new Error('CLI completed; restart requires an explicit new task'); }
  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.process;
    this.process = undefined;
    child?.kill();
  }
  async cancel(): Promise<void> { this.stop(); }
  async close(): Promise<void> { await this.cancel(); this.queue.close(); }
}
