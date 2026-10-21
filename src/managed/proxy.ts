import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { managedConnection } from './runtime.js';
import type { ManagedPaths } from './paths.js';

/** Each request resolves the current daemon, so a client survives daemon restarts.
 * Mutating requests are never replayed after a failed connection. */
export function createManagedProxy(paths: ManagedPaths): Server {
  const server = new Server({ name: 'grok-agent-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const remote = await managedConnection(paths);
    try { return await remote.client.listTools({}, { signal: extra.signal, timeout: 15000 }); }
    finally { await remote.close(); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!/^agent_[a-z_]+$/.test(request.params.name)) throw new Error('Only coding-agent bridge tools are available');
    const remote = await managedConnection(paths);
    try { return await remote.client.callTool(request.params, undefined, { signal: extra.signal, timeout: 600000 }); }
    finally { await remote.close(); }
  });
  return server;
}

export async function connectManaged(paths: ManagedPaths): Promise<Server> {
  const server = createManagedProxy(paths);
  await server.connect(new StdioServerTransport());
  return server;
}
