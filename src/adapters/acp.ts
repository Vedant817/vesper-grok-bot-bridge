import { RpcWorker } from './rpc-worker.js';
import type { RpcMessage, Wire } from '../rpc.js';
import type { WorkerEvent } from '../contracts.js';

/** ACP v1: session/prompt is the turn; session/turn is not a standard method. */
export class AcpWorker extends RpcWorker {
  private session?: string;
  private active = false;
  constructor(connect: (cwd: string) => Promise<Wire>, private readonly options: { model?: string; resumeId?: string } = {}) { super(connect); }
  get nativeSessionId(): string | undefined { return this.session; }
  async start(cwd: string, task: string): Promise<void> {
    const rpc = await this.open(cwd);
    const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-supervisor', version: '0.1.0' } });
    if (init.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    if (this.options.resumeId && init.agentCapabilities?.loadSession !== true) throw new Error('ACP agent does not support session loading');
    const session = await rpc.request(this.options.resumeId ? 'session/load' : 'session/new', { ...(this.options.resumeId ? { sessionId: this.options.resumeId } : {}), cwd, mcpServers: [] });
    if (!this.options.resumeId && typeof session.sessionId !== 'string') throw new Error('ACP missing sessionId');
    if (this.options.resumeId && session.sessionId && session.sessionId !== this.options.resumeId) throw new Error('ACP resumed a different session');
    this.session = this.options.resumeId ?? session.sessionId;
    if (this.options.model) {
      if (session.models?.availableModels?.some((m: any) => m.modelId === this.options.model)) {
        await rpc.request('session/set_model', { sessionId: this.session, modelId: this.options.model });
      } else {
        const config = session.configOptions?.find((o: any) => o.category === 'model' && o.type === 'select');
        const values = config?.options?.flatMap((o: any) => o.options ?? [o]);
        if (!config || !values?.some((o: any) => o.value === this.options.model)) throw new Error('ACP requested model is unavailable');
        await rpc.request('session/set_config_option', { sessionId: this.session, configId: config.id, value: this.options.model });
      }
    }
    this.prompt(task);
  }
  private prompt(text: string): void {
    if (this.active) throw new Error('ACP turn already active');
    this.active = true;
    void this.rpc!.request('session/prompt', { sessionId: this.session, prompt: [{ type: 'text', text }] }).then(result => {
      this.active = false;
      if (!result || typeof result.stopReason !== 'string') throw new Error('Invalid ACP prompt result');
      if (result.stopReason === 'end_turn') this.queue.push({ type: 'completed', summary: 'ACP end_turn' });
      else this.queue.push({ type: 'failed', error: `ACP stop reason: ${result.stopReason}` });
    }).catch(error => { this.active = false; this.queue.push({ type: 'failed', error: String(error) }); });
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
