import type { Worker, WorkerEvent } from '../contracts.js';
import { McpConnection, discoverT3 } from '../adapters/mcp.js';
import { T3Worker } from '../adapters/t3.js';
import type { Provider } from './provider.js';

export interface T3BridgeConfig { projectId: string; endpoint?: string; legacyEndpoint?: string; tokenEnv?: string }
/** Each worker owns its authenticated MCP connection, never an application's credentials. */
class T3BridgeWorker implements Worker {
  private worker?: T3Worker;
  constructor(private config: T3BridgeConfig, private instanceId: string, private model: string, private resumeId?: string) {}
  get nativeSessionId(): string | undefined { return this.worker?.nativeSessionId; }
  async start(cwd: string, task: string): Promise<void> {
    const endpoint = this.config.endpoint ?? (await discoverT3()).endpoint;
    const token = process.env[this.config.tokenEnv ?? 'T3_BEARER_TOKEN'] ?? '';
    const connection = await McpConnection.connect(endpoint, token, this.config.legacyEndpoint ?? endpoint);
    this.worker = new T3Worker(connection, this.config.projectId, 'Supervised coding session', { instanceId: this.instanceId, model: this.model, resumeId: this.resumeId });
    try { await this.worker.start(cwd, task); } catch (error) { await this.worker.close(); throw error; }
  }
  async next(signal: AbortSignal): Promise<WorkerEvent> { if (!this.worker) throw new Error('T3 session not started'); return this.worker.next(signal); }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> { if (!this.worker) throw new Error('T3 session not started'); await this.worker.respond(id, response); }
  async steer(text: string): Promise<void> { if (!this.worker) throw new Error('T3 session not started'); await this.worker.steer(text); }
  async cancel(): Promise<void> { await this.worker?.cancel(); }
  async close(): Promise<void> { await this.worker?.close(); }
}
export async function discoverT3Providers(config: T3BridgeConfig): Promise<Provider[]> {
  let connection: McpConnection | undefined;
  try {
    const endpoint = config.endpoint ?? (await discoverT3()).endpoint;
    connection = await McpConnection.connect(endpoint, process.env[config.tokenEnv ?? 'T3_BEARER_TOKEN'] ?? '', config.legacyEndpoint ?? endpoint);
    const catalog = await connection.call('orchestrator_capabilities', {});
    if (!Array.isArray(catalog.providers)) throw new Error('Invalid T3 provider catalog');
    return catalog.providers.map((p: any): Provider => ({
      id: `t3:${p.providerInstanceId}`, label: `T3 Code / ${p.displayName ?? p.providerInstanceId}`,
      models: Array.isArray(p.models) ? p.models.map((m: any) => m.id).filter((m: unknown): m is string => typeof m === 'string') : [],
      available: p.canRunChildTask === true, reason: Array.isArray(p.constraints) ? p.constraints.join('; ') : undefined,
      create: ({ model, resumeId }) => new T3BridgeWorker(config, p.providerInstanceId, model, resumeId)
    }));
  } catch {
    return [{ id: 't3', label: 'T3 Code', models: [], available: false, reason: 'T3 MCP discovery/authentication unavailable. Configure projectId and a T3_BEARER_TOKEN issued by t3 auth session issue --subject mcp-client.', create() { throw new Error('T3 MCP unavailable'); } }];
  } finally { await connection?.close().catch(() => {}); }
}
