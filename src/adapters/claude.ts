import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AsyncQueue, type Wire, type RpcMessage } from '../rpc.js';
import type { Worker, WorkerEvent } from '../contracts.js';
import { scopedPath } from './scoped-path.js';
import { Redactor } from '../safety.js';

/** Native Claude Code bidirectional stream-json control protocol (Agent SDK). */
export class ClaudeWorker implements Worker {
  private wire?: Wire;
  private queue = new AsyncQueue<WorkerEvent>();
  private pending = new Map<string, any>();
  private session?: string;
  private active = false;
  private cancelling = false;
  private closed = false;
  private cwd = '';
  constructor(private readonly connect: (cwd: string) => Promise<Wire>, private readonly resumeId?: string) {}
  get nativeSessionId(): string | undefined { return this.session; }
  private send(frame: unknown): void { if (!this.wire || this.closed) throw new Error('Claude connection closed'); this.wire.send(frame as RpcMessage); }
  async start(cwd: string, task: string): Promise<void> {
    this.cwd = cwd;
    const wire = await this.connect(cwd);
    if (this.closed) { wire.close(); throw new Error('Claude closed while connecting'); }
    this.wire = wire;
    const requestId = randomUUID();
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude initialization timeout')), 30000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); this.disconnect(error); };
      wire.onClose = fail;
      wire.onMessage = (raw) => {
        const m = raw as any;
        if (m.type === 'control_response' && m.response?.request_id === requestId) {
          clearTimeout(timer);
          if (m.response.subtype === 'error') reject(new Error('Claude initialization rejected'));
          else { wire.onClose = error => this.disconnect(error); accept(); }
        } else this.receive(m);
      };
      this.send({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {} } });
    });
    await this.steer(task);
  }
  private receive(m: any): void {
    if (this.closed) return;
    if (m.type === 'control_cancel_request') { if (typeof m.request_id === 'string') this.resolvePending(m.request_id); return; }
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id !== 'string' || (this.resumeId && (m.session_id !== this.resumeId || typeof m.cwd !== 'string' || resolve(m.cwd) !== resolve(this.cwd)))) {
        this.queue.push({ type: 'failed', error: 'Claude session identity or directory mismatch' }); this.wire?.close(); return;
      }
      this.session = m.session_id;
    }
    if (m.type === 'control_request') {
      if (typeof m.request_id !== 'string') return;
      if (this.pending.has(m.request_id)) { this.queue.close(new Error('Duplicate Claude request ID')); this.wire?.close(); return; }
      if (!this.active || this.cancelling || m.request?.subtype !== 'can_use_tool' || this.pending.size >= 100) { this.reply(m.request_id, { behavior: 'deny', message: 'Unsupported control request' }); return; }
      const r = m.request;
      if (r.tool_name === 'AskUserQuestion') {
        const q = r.input?.questions;
        if (!Array.isArray(q) || q.length !== 1 || typeof q[0].question !== 'string' || q[0].multiSelect) { this.reply(m.request_id, { behavior: 'deny', message: 'Only single questions supported' }); return; }
        this.pending.set(m.request_id, r);
        this.queue.push({ type: 'question', id: m.request_id, question: q[0].question, options: q[0].options?.map((o: any) => o.label) });
      } else {
        this.pending.set(m.request_id, r);
        const fileTool = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(r.tool_name);
        const scoped = fileTool ? scopedPath(this.cwd, r.input?.file_path ?? r.input?.notebook_path) : r.tool_name === 'Bash' && typeof r.input?.command === 'string';
        this.queue.push({ type: 'permission', id: m.request_id, request: { ...(scoped ? { cwd: this.cwd } : {}), command: r.tool_name === 'Bash' ? r.input?.command : undefined, description: JSON.stringify({ tool: r.tool_name, input: r.input, scopeEvidence: scoped ? 'Bound to worktree' : 'Missing or outside-worktree file path' }) } });
      }
    }
    if (m.type === 'assistant' && !m.parent_tool_use_id) for (const c of m.message?.content ?? []) if (c.type === 'text' && typeof c.text === 'string') this.queue.push({ type: 'output', text: c.text });
    if (m.type === 'result' && this.active) {
      this.active = false;
      for (const id of this.pending.keys()) this.resolvePending(id);
      const errors = Array.isArray(m.errors) ? m.errors.filter((e: unknown): e is string => typeof e === 'string' && !!e.trim()) : [];
      const detail = errors.length ? errors.join('; ') : typeof m.result === 'string' && m.result.trim() ? m.result : typeof m.subtype === 'string' && m.subtype !== 'success' ? m.subtype : typeof m.api_error_status === 'number' ? `API error (HTTP ${m.api_error_status})` : 'unknown error';
      this.queue.push(m.is_error || m.subtype !== 'success' ? { type: 'failed', error: new Redactor().redact(`Claude turn failed: ${detail}`).slice(0, 16000) } : { type: 'completed', summary: typeof m.result === 'string' ? m.result : 'Claude turn completed' });
    }
  }
  private disconnect(error: Error): void { this.closed = true; this.active = false; this.pending.clear(); this.queue.close(error); }
  private resolvePending(id: string): void { if (this.pending.delete(id)) this.queue.push({ type: 'pendingResolved', id }); }
  private reply(id: string, response: unknown): void { this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }); }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> {
    const r = this.pending.get(id); if (!r) throw new Error('Unknown or already answered request'); this.pending.delete(id);
    if (r.tool_name === 'AskUserQuestion' && response.answer !== undefined) this.reply(id, { behavior: 'allow', updatedInput: { ...r.input, answers: { [r.input.questions[0].question]: response.answer } } });
    else this.reply(id, response.allow ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: 'Supervisor denied request' });
  }
  async steer(text: string): Promise<void> {
    if (this.active) throw new Error('Claude turn already active');
    this.active = true;
    this.cancelling = false;
    this.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.session ?? this.resumeId ?? '' });
  }
  async cancel(): Promise<void> {
    if (this.active) {
      this.cancelling = true;
      for (const id of this.pending.keys()) this.resolvePending(id);
      this.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    }
  }
  next(signal: AbortSignal): Promise<WorkerEvent> { return this.queue.next(signal); }
  async close(): Promise<void> { this.closed = true; this.wire?.close(); this.pending.clear(); this.queue.close(); }
}
