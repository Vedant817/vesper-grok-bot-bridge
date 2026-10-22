import { Rpc, type Wire } from '../rpc.js';
import { Redactor } from '../safety.js';

/** Handshake evidence only: initialization neither logs in nor creates a session. */
export interface AcpDiscovery {
  protocolVersion: 1;
  agentInfo?: { name: string; title?: string; version?: string };
  capabilities: { loadSession: boolean };
  authMethods: { id: string; name?: string }[];
  authentication: 'not_checked';
}

const redactor = new Redactor();
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? redactor.redact(value) : undefined;
}

/** Bounded, initialize-only ACP v1 probe. Always releases the owned transport. */
export async function probeAcp(connect: () => Wire, timeoutMs = 10000): Promise<AcpDiscovery> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid ACP discovery timeout');
  const rpc = new Rpc(connect(), timeoutMs);
  rpc.onRequest = message => rpc.reject(message.id!, 'Discovery does not serve agent requests');
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'grok-agent-bridge-discovery', version: '0.1.0' }
    });
    if (init?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    if (init.authMethods !== undefined && (!Array.isArray(init.authMethods) || init.authMethods.length > 32 || init.authMethods.some((method: any) => !text(method?.id)))) throw new Error('Invalid ACP authentication metadata');
    const agentName = text(init.agentInfo?.name);
    return {
      protocolVersion: 1,
      ...(agentName ? { agentInfo: { name: agentName, ...(text(init.agentInfo?.title) ? { title: text(init.agentInfo.title) } : {}), ...(text(init.agentInfo?.version) ? { version: text(init.agentInfo.version) } : {}) } } : {}),
      capabilities: { loadSession: init.agentCapabilities?.loadSession === true },
      authMethods: (init.authMethods ?? []).map((method: any) => ({ id: text(method.id)!, ...(text(method.name) ? { name: text(method.name) } : {}) })),
      authentication: 'not_checked'
    };
  } finally { rpc.close(); }
}
