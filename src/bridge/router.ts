import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { BridgeService } from './service.js';
import { InstructionNotSubmittedError } from '../contracts.js';

const binding = z.object({ taskKey: z.string(), sessionId: z.string(), provider: z.string(), model: z.string(), directory: z.string() }).strict();
const receipt = z.object({ requestId: z.string(), fingerprint: z.string(), taskKey: z.string(), action: z.enum(['start', 'continue', 'observe']), state: z.enum(['prepared', 'complete', 'rejected']), sessionId: z.string().optional(), instructionSubmitted: z.boolean() }).strict();
const storage = z.object({ version: z.literal(1), bindings: z.array(binding).max(1000), receipts: z.array(receipt).max(1000) }).strict();
type RoutingState = z.infer<typeof storage>;
export interface DispatchTask {
  taskKey: string; requestId: string; provider: string; model: string; directory: string; instruction: string;
  intent?: 'auto' | 'new' | 'continue'; sessionId?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Explicit task identities, durable mutation receipts, and no replay of uncertain continuations. */
export class TaskRouter {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly submit: <T>(work: () => Promise<T>) => Promise<T>;
  private constructor(private bridge: BridgeService, private file: string, private state: RoutingState) {
    this.submit = bridge.installMutationGuard(() => {
      if (this.state.receipts.some(r => r.state === 'prepared')) throw new Error('An operation is uncertain; reconcile its original receipt before using direct mutation tools. Use dispatch for independent tasks.');
    });
  }
  static async create(bridge: BridgeService, stateDirectory: string) {
    const file = join(stateDirectory, 'routing.json');
    let state: RoutingState = { version: 1, bindings: [], receipts: [] };
    try { state = storage.parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid routing state; inspect it before submitting work'); }
    if (new Set(state.bindings.map(b => b.taskKey)).size !== state.bindings.length || new Set(state.receipts.map(r => r.requestId)).size !== state.receipts.length) throw new Error('Duplicate routing records');
    return new TaskRouter(bridge, file, state);
  }
  dispatch(input: DispatchTask) {
    const operation = this.tail.then(() => this.run(input));
    this.tail = operation.catch(() => {}); return operation;
  }
  private async run(input: DispatchTask) {
    for (const value of [input.taskKey, input.requestId, input.provider, input.model]) if (!value?.trim() || value.length > 200) throw new Error('Invalid task identity or provider selection');
    if (!input.instruction?.trim() || input.instruction.length > 16000 || !isAbsolute(input.directory)) throw new Error('Invalid instruction or absolute directory');
    const directory = await realpath(input.directory), intent = input.intent ?? 'auto';
    if (!['auto', 'new', 'continue'].includes(intent)) throw new Error('Invalid dispatch intent');
    if (intent === 'new' && input.sessionId) throw new Error('New work cannot select an existing session');
    const fingerprint = hash(JSON.stringify({ taskKey: input.taskKey, provider: input.provider, model: input.model, directory, instruction: input.instruction, intent, sessionId: input.sessionId }));
    const previous = this.state.receipts.find(r => r.requestId === input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('requestId already used for different dispatch input');
      if (previous.state === 'rejected') throw new Error('This request was rejected before submission; correct the input and use a new requestId');
      if (previous.state === 'prepared') {
        if (previous.action !== 'start') throw new Error('Continuation outcome is uncertain; inspect the original session before a new request. This instruction will not be replayed.');
        const recovered = this.bridge.list().find(s => s.requestId === this.startId(input.requestId));
        if (!recovered) throw new Error('Start outcome is uncertain; inspect retained sessions and worktrees before submitting another request');
        const expected = hash(JSON.stringify({ provider: input.provider, model: input.model, directory, task: input.instruction, requestId: this.startId(input.requestId) }));
        if (recovered.fingerprint !== expected || recovered.provider !== input.provider || recovered.model !== input.model || recovered.directory !== directory) throw new Error('Recovered session does not match the exact dispatch input; owner reconciliation is required');
        previous.sessionId = recovered.id; previous.state = 'complete';
        this.bind(input, directory, recovered.id); await this.persist();
      }
      return this.result(previous, true);
    }
    if (this.state.receipts.some(r => r.state === 'prepared' && (r.taskKey === input.taskKey || (input.sessionId !== undefined && r.sessionId === input.sessionId)))) throw new Error('Task has an uncertain operation; inspect and reconcile the original request before any further instruction');
    if (this.state.receipts.length >= 1000) throw new Error('Routing receipt capacity reached; archive state with the bridge stopped before adding work');
    const known = this.state.bindings.find(b => b.taskKey === input.taskKey);
    if (known && (known.provider !== input.provider || known.model !== input.model || known.directory !== directory)) throw new Error('Task is bound to another directory, provider, or model; select its exact scope');
    if (known && input.sessionId && input.sessionId !== known.sessionId) throw new Error('Task is already bound to a different session');
    if (known && intent === 'new') throw new Error('Use a new taskKey to start independent work; this task already owns a session');
    const sessionId = known?.sessionId ?? input.sessionId;
    if (sessionId && this.state.receipts.some(r => r.state === 'prepared' && (r.sessionId ?? (r.action === 'start' ? this.bridge.list().find(s => s.requestId === this.startId(r.requestId))?.id : undefined)) === sessionId)) throw new Error('Selected session has an uncertain operation; changing the task key cannot authorize another instruction');
    if (!sessionId && intent === 'continue') throw new Error('No session is bound to this task; select an existing session or explicitly start a new task');
    const session = sessionId ? this.bridge.read(sessionId) : undefined;
    if (session && (session.provider !== input.provider || session.model !== input.model || session.directory !== directory)) throw new Error('Selected session does not match the exact task scope');
    if (session && !known && this.state.bindings.some(b => b.sessionId === session.id)) throw new Error('Session is already bound to another task');
    if (!known && this.state.bindings.length >= 1000) throw new Error('Task binding capacity reached');
    const action = !session ? 'start' : ['awaiting_review', 'interrupted'].includes(session.status) ? 'continue' : 'observe';
    const record: RoutingState['receipts'][number] = { requestId: input.requestId, fingerprint, taskKey: input.taskKey, action, state: action === 'observe' ? 'complete' : 'prepared', sessionId, instructionSubmitted: action !== 'observe' };
    this.state.receipts.push(record);
    if (session) this.bind(input, directory, session.id);
    // Persist intent before sending a native mutation. Failed/unknown continuations are never replayed.
    await this.persist();
    try {
      if (action === 'start') {
        const created = await this.submit(() => this.bridge.start({ provider: input.provider, model: input.model, directory, task: input.instruction, requestId: this.startId(input.requestId) }));
        record.sessionId = created.id; this.bind(input, directory, created.id);
      } else if (action === 'continue') await this.submit(() => this.bridge.continueSession(session!.id, input.instruction));
    } catch (error) {
      // Service persists a start snapshot before native execution. No matching snapshot means no instruction was submitted.
      const started = action === 'start' && this.bridge.list().find(s => s.requestId === this.startId(input.requestId));
      const expected = hash(JSON.stringify({ provider: input.provider, model: input.model, directory, task: input.instruction, requestId: this.startId(input.requestId) }));
      if (error instanceof InstructionNotSubmittedError || (action === 'start' && (!started || started.fingerprint !== expected))) {
        record.state = 'rejected'; record.instructionSubmitted = false; await this.persist();
      }
      throw error;
    }
    record.state = 'complete'; await this.persist();
    return this.result(record, false);
  }
  private startId(requestId: string) { return `dispatch-${hash(requestId)}`; }
  private bind(input: DispatchTask, directory: string, sessionId: string) {
    if (!this.state.bindings.some(b => b.taskKey === input.taskKey)) this.state.bindings.push({ taskKey: input.taskKey, provider: input.provider, model: input.model, directory, sessionId });
  }
  private result(record: RoutingState['receipts'][number], replayed: boolean) {
    return { taskKey: record.taskKey, action: record.action, replayed, instructionSubmitted: record.instructionSubmitted, session: this.bridge.read(record.sessionId!) };
  }
  private async persist() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
