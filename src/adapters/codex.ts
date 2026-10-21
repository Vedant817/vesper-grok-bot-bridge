import { RpcWorker } from './rpc-worker.js';
import type { RpcMessage, Wire } from '../rpc.js';
import type { WorkerEvent } from '../contracts.js';
import { resolve } from 'node:path';
import { scopedPath } from './scoped-path.js';
import { Redactor } from '../safety.js';

export class CodexWorker extends RpcWorker {
  private thread?: string;
  private turn?: string;
  private starting = false;
  private cancelling = false;
  private early: RpcMessage[] = [];
  private fileChanges = new Map<string, any[]>();
  private turnError?: unknown;
  constructor(connect: (cwd: string) => Promise<Wire>, private readonly options: { model?: string; resumeId?: string } = {}) { super(connect, false); }
  get nativeSessionId(): string | undefined { return this.thread; }
  async start(cwd: string, task: string): Promise<void> {
    const rpc = await this.open(cwd);
    await rpc.request('initialize', { clientInfo: { name: 'grok-supervisor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    if (this.options.resumeId) {
      const existing = await rpc.request('thread/read', { threadId: this.options.resumeId, includeTurns: false });
      if (typeof existing.thread?.cwd !== 'string' || resolve(existing.thread.cwd) !== resolve(cwd)) throw new Error('Codex resume directory mismatch');
    }
    const result = await rpc.request(this.options.resumeId ? 'thread/resume' : 'thread/start', { ...(this.options.resumeId ? { threadId: this.options.resumeId } : {}), ...(this.options.model ? { model: this.options.model } : {}), cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    if (typeof result.thread?.id !== 'string') throw new Error('Codex missing thread id');
    if (this.options.resumeId && result.thread.id !== this.options.resumeId) throw new Error('Codex resumed a different thread');
    if (this.options.model && result.model !== this.options.model) throw new Error('Codex did not confirm requested model');
    this.thread = result.thread.id; await this.steer(task);
  }
  async steer(text: string): Promise<void> {
    if (this.starting || this.turn) throw new Error('Codex turn already active');
    this.turnError = undefined;
    this.cancelling = false;
    this.starting = true;
    try {
      const result = await this.rpc!.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text }] });
      if (typeof result?.turn?.id !== 'string') throw new Error('Codex missing turn id');
      this.turn = result.turn.id;
    } finally { this.starting = false; }
    for (const message of this.early.splice(0)) this.notification(message);
    if (this.cancelling) await this.cancel();
  }
  protected request(message: RpcMessage): WorkerEvent | undefined | null {
    const p = message.params as any;
    if (p?.threadId !== this.thread) return undefined;
    if (!this.starting && !this.turn) return undefined;
    if (this.cancelling) return undefined;
    if (p.turnId && !this.starting && p.turnId !== this.turn) return undefined;
    if (message.method === 'item/permissions/requestApproval') { this.rpc!.respond(message.id!, { permissions: {}, scope: 'turn' }); return null; }
    if (message.method === 'mcpServer/elicitation/request') { this.rpc!.respond(message.id!, { action: 'decline', content: null }); return null; }
    if (message.method === 'item/fileChange/requestApproval') {
      const changes = this.fileChanges.get(p.itemId);
      const bound = changes?.length && changes.every(change => scopedPath(this.cwd, change.path) && (change.kind?.type !== 'update' || !change.kind.move_path || scopedPath(this.cwd, change.kind.move_path)));
      return { type: 'permission', id: String(message.id), request: { ...(bound ? { cwd: this.cwd } : {}), description: JSON.stringify({ ...p, changes: changes ?? [], scopeEvidence: bound ? 'Validated file change paths' : 'Missing or outside-worktree file change evidence' }) } };
    }
    if (message.method === 'item/commandExecution/requestApproval') return { type: 'permission', id: String(message.id), request: { command: p.command, cwd: p.cwd, description: JSON.stringify(p) } };
    if (message.method === 'item/tool/requestUserInput') {
      const questions = p.questions;
      if (!Array.isArray(questions) || questions.length !== 1 || typeof questions[0].question !== 'string') return undefined;
      return { type: 'question', id: String(message.id), question: questions[0].question, options: questions[0].options?.map((o: any) => o.label) };
    }
    return undefined;
  }
  protected notification(message: RpcMessage): void {
    const p = message.params as any;
    if (p?.threadId !== this.thread) return;
    if (message.method === 'serverRequest/resolved') {
      if (typeof p.requestId === 'string' || typeof p.requestId === 'number') this.resolvePending(String(p.requestId));
      return;
    }
    if (this.starting) { if (this.early.length >= 100) this.queue.close(new Error('Early Codex event limit')); else this.early.push(message); return; }
    if (message.method === 'turn/completed' && (!this.turn || p.turn?.id !== this.turn)) return;
    if (p.turnId && p.turnId !== this.turn) return;
    if (message.method === 'error' && this.turn && p.turnId === this.turn && p.willRetry !== true) this.turnError = p.error;
    if (message.method === 'item/started' && p.item?.type === 'fileChange' && typeof p.item.id === 'string' && Array.isArray(p.item.changes)) {
      if (this.fileChanges.size >= 100) this.fileChanges.delete(this.fileChanges.keys().next().value!);
      this.fileChanges.set(p.item.id, p.item.changes);
    }
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') this.queue.push({ type: 'output', text: p.delta });
    if (message.method === 'turn/completed') {
      this.turn = undefined;
      this.fileChanges.clear();
      this.resolveAllPending();
      const error = p.turn?.error ?? this.turnError;
      this.turnError = undefined;
      this.queue.push(p.turn?.status === 'completed' ? { type: 'completed', summary: 'Codex turn completed' } : { type: 'failed', error: new Redactor().redact(`Codex turn ${p.turn?.status}${error ? ': ' + new Redactor().json(error) : ''}`).slice(0, 16000) });
    }
  }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> {
    const message = this.take(id);
    if (message.method === 'item/tool/requestUserInput') {
      const q = (message.params as any).questions[0];
      this.rpc!.respond(message.id!, { answers: { [q.id]: { answers: [response.answer ?? 'Unable to resolve safely'] } } });
    } else this.rpc!.respond(message.id!, { decision: response.allow ? 'accept' : 'decline' });
  }
  async cancel(): Promise<void> {
    this.cancelling = true;
    if (this.thread && this.turn) {
      this.resolveAllPending();
      await this.rpc?.request('turn/interrupt', { threadId: this.thread, turnId: this.turn });
    }
  }
}
