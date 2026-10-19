import { RpcWorker } from './rpc-worker.js';
import type { RpcMessage, Wire } from '../rpc.js';
import type { WorkerEvent } from '../contracts.js';

export class CodexWorker extends RpcWorker {
  private thread?: string;
  private turn?: string;
  private starting = false;
  private early: RpcMessage[] = [];
  constructor(connect: (cwd: string) => Promise<Wire>) { super(connect, false); }
  async start(cwd: string, task: string): Promise<void> {
    const rpc = await this.open(cwd);
    await rpc.request('initialize', { clientInfo: { name: 'grok-supervisor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const result = await rpc.request('thread/start', { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    if (typeof result.thread?.id !== 'string') throw new Error('Codex missing thread id');
    this.thread = result.thread.id; await this.steer(task);
  }
  async steer(text: string): Promise<void> {
    if (this.starting || this.turn) throw new Error('Codex turn already active');
    this.starting = true;
    try {
      const result = await this.rpc!.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text }] });
      if (typeof result?.turn?.id !== 'string') throw new Error('Codex missing turn id');
      this.turn = result.turn.id;
    } finally { this.starting = false; }
    for (const message of this.early.splice(0)) this.notification(message);
  }
  protected request(message: RpcMessage): WorkerEvent | undefined | null {
    const p = message.params as any;
    if (p?.threadId !== this.thread) return undefined;
    if (message.method === 'item/permissions/requestApproval') { this.rpc!.respond(message.id!, { permissions: {}, scope: 'turn' }); return null; }
    if (message.method === 'mcpServer/elicitation/request') { this.rpc!.respond(message.id!, { action: 'decline', content: null }); return null; }
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') return { type: 'permission', id: String(message.id), request: { command: p.command, cwd: p.cwd, description: JSON.stringify(p) } };
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
    if (this.starting) { if (this.early.length >= 100) this.queue.close(new Error('Early Codex event limit')); else this.early.push(message); return; }
    if (message.method === 'turn/completed' && (!this.turn || p.turn?.id !== this.turn)) return;
    if (p.turnId && p.turnId !== this.turn) return;
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') this.queue.push({ type: 'output', text: p.delta });
    if (message.method === 'turn/completed') {
      this.turn = undefined;
      this.queue.push(p.turn?.status === 'completed' ? { type: 'completed', summary: 'Codex turn completed' } : { type: 'failed', error: `Codex turn ${p.turn?.status}` });
    }
  }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> {
    const message = this.take(id);
    if (message.method === 'item/tool/requestUserInput') {
      const q = (message.params as any).questions[0];
      this.rpc!.respond(message.id!, { answers: { [q.id]: { answers: [response.answer ?? 'Unable to resolve safely'] } } });
    } else this.rpc!.respond(message.id!, { decision: response.allow ? 'accept' : 'decline' });
  }
  async cancel(): Promise<void> { if (this.thread && this.turn) await this.rpc?.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }); }
}
