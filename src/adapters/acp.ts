import { RpcWorker } from './rpc-worker.js';
import type { RpcMessage } from '../rpc.js';
import type { WorkerEvent } from '../contracts.js';

/** ACP v1: session/prompt is the turn; session/turn is not a standard method. */
export class AcpWorker extends RpcWorker {
  private session?: string;
  private active = false;
  async start(cwd: string, task: string): Promise<void> {
    const rpc = await this.open(cwd);
    const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-supervisor', version: '0.1.0' } });
    if (init.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    const session = await rpc.request('session/new', { cwd, mcpServers: [] });
    if (typeof session.sessionId !== 'string') throw new Error('ACP missing sessionId');
    this.session = session.sessionId; this.prompt(task);
  }
  private prompt(text: string): void {
    if (this.active) throw new Error('ACP turn already active');
    this.active = true;
    void this.rpc!.request('session/prompt', { sessionId: this.session, prompt: [{ type: 'text', text }] }).then(result => {
      this.active = false;
      if (result.stopReason === 'end_turn') this.queue.push({ type: 'completed', summary: 'ACP end_turn' });
      else this.queue.push({ type: 'failed', error: `ACP stop reason: ${result.stopReason}` });
    }, error => { this.active = false; this.queue.push({ type: 'failed', error: String(error) }); });
  }
  protected request(message: RpcMessage): WorkerEvent | undefined | null {
    const p = message.params as any;
    if (message.method === 'elicitation/create') { this.rpc!.respond(message.id!, { action: 'decline' }); return null; }
    if (message.method === '_supervisor/ask_question' && p?.sessionId === this.session && typeof p.question === 'string') return { type: 'question', id: String(message.id), question: p.question, options: p.options };
    if (message.method === 'session/request_permission' && p?.sessionId === this.session) return { type: 'permission', id: String(message.id), request: { cwd: this.cwd, description: JSON.stringify(p.toolCall) } };
    // Extensions must be handled explicitly by their producer, never as ACP standard.
    return undefined;
  }
  protected notification(message: RpcMessage): void {
    const p = message.params as any;
    if (message.method === 'session/update' && p?.sessionId === this.session && p.update?.content?.type === 'text') this.queue.push({ type: 'output', text: p.update.content.text });
  }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> {
    const message = this.take(id), p = message.params as any;
    if (message.method === '_supervisor/ask_question') { this.rpc!.respond(message.id!, { answer: response.answer ?? 'Unable to resolve safely' }); return; }
    const option = p.options?.find((o: any) => o.kind === (response.allow ? 'allow_once' : 'reject_once'));
    this.rpc!.respond(message.id!, option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
  }
  async steer(message: string): Promise<void> { this.prompt(message); }
  async cancel(): Promise<void> { if (this.session && this.active) this.rpc?.notify('session/cancel', { sessionId: this.session }); }
}
