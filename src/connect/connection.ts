import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpConnection, type ToolCaller } from '../adapters/mcp.js';
import { ConnectReauthorizationRequired, connectEndpoint, sameOriginFetch } from './security.js';
import { credentialReference, FileConnectCredentialStore, type ConnectCredentialStore } from './store.js';
import { discoverConnectLauncher } from './launcher.js';

export interface ConnectBridgeLauncher { command: string; args?: string[] }
export interface ConnectConnectionOptions {
  endpoint: string;
  credentialRef: string;
  bridge?: ConnectBridgeLauncher;
  store?: ConnectCredentialStore;
}
export interface ConnectToolCaller extends ToolCaller { readonly transportKind: 'official-stdio' | 'https-sdk' }

export async function connectT3(options: ConnectConnectionOptions): Promise<ConnectToolCaller> {
  const endpoint = connectEndpoint(options.endpoint), ref = credentialReference(endpoint.href);
  if (ref !== options.credentialRef) throw new Error('Connect credential endpoint mismatch');
  const store = options.store ?? new FileConnectCredentialStore();
  const record = await store.read(ref);
  if (!record || record.endpoint !== endpoint.href || record.rejected || record.expiresAt <= Date.now()) throw new ConnectReauthorizationRequired();
  let rejected = false;
  const invalidate = async () => {
    rejected = true;
    const current = await store.read(ref);
    if (current?.accessToken === record.accessToken) await store.write(ref, { ...current, rejected: true });
  };
  const baseFetch = sameOriginFetch(endpoint);
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status === 401) { await invalidate(); throw new ConnectReauthorizationRequired(); }
    return response;
  };
  let connection: McpConnection;
  const bridge = options.bridge ?? await discoverConnectLauncher();
  const transportKind = bridge ? 'official-stdio' : 'https-sdk';
  try {
    if (bridge) {
      const { command, args = [] } = bridge;
      if (!command || /[\r\n]/.test(command) || command.includes(record.accessToken) || args.some(arg => arg.includes(record.accessToken))) throw new Error();
      // Launcher arguments are a user-selected executable prefix, e.g. [entrypoint.js].
      // T3's command and credentials are appended/injected here, never supplied by callers.
      connection = await McpConnection.connectStdio(command, [...args, 'acp-mcp-bridge'], {
        ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1',
        T3_ACP_MCP_ENDPOINT: endpoint.href, T3_ACP_MCP_AUTHORIZATION: `Bearer ${record.accessToken}`
      }, record.accessToken);
    } else connection = await McpConnection.connectRemote(endpoint.href, record.accessToken, fetchFn);
  } catch (error) {
    if (rejected || /\bHTTP 401\b/.test(error instanceof Error ? error.message : '')) {
      await invalidate(); throw new ConnectReauthorizationRequired();
    }
    throw new Error(`T3 Connect ${transportKind} connection failed; check the endpoint, launcher and approval`);
  }
  return {
    transportKind,
    async call<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (rejected || record.expiresAt <= Date.now()) throw new ConnectReauthorizationRequired();
      try { return await connection.call<T>(name, args, signal); }
      catch (error) {
        // Official bridge HTTP failures are JSON-RPC errors. Inspect privately; do not echo
        // remote error bodies, which can contain authorization or attacker-controlled text.
        if (rejected || /\bHTTP 401\b/.test(error instanceof Error ? error.message : '')) {
          await invalidate(); throw new ConnectReauthorizationRequired();
        }
        throw new Error('T3 Connect MCP request failed');
      }
    },
    async close() { await connection.close().catch(() => {}); }
  };
}
