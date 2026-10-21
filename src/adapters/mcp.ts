import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Redactor } from '../safety.js';
import { connectEndpoint } from '../connect/security.js';

function preferRequiredVersion(transport: Transport): void {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send('method' in message && message.method === 'initialize' ? { ...message, params: { ...message.params, protocolVersion: '2025-06-18' } } : message, options);
}

export interface ToolCaller { call<T = any>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>; close(): Promise<void> }
export function loopbackUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('MCP endpoint must be authenticated loopback HTTP(S)');
  return url;
}
export async function discoverT3(path = join(homedir(), '.t3', 'userdata', 'server-runtime.json')): Promise<{ endpoint: string }> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  // Discovery contract is deliberately narrow; unknown runtime shapes fail explicitly.
  const endpoint = raw.mcpUrl ?? raw.mcp?.url ?? (raw.version === 1 && typeof raw.origin === 'string' ? new URL('/mcp', raw.origin).href : undefined);
  if (typeof endpoint !== 'string') throw new Error('Runtime has no mcpUrl or mcp.url; set endpoint explicitly');
  return { endpoint: loopbackUrl(endpoint).href };
}
export class McpConnection implements ToolCaller {
  private readonly redactor: Redactor;
  private constructor(readonly client: Client, readonly transportKind: 'http' | 'sse' | 'stdio', private readonly transport: Transport, token: string) { this.redactor = new Redactor([token]); }
  /** Supported public Connect resource. No local discovery or legacy SSE downgrade. */
  static async connectRemote(endpoint: string, token: string, fetchFn: typeof fetch): Promise<McpConnection> {
    if (!token) throw new Error('MCP bearer token required');
    const client = new Client({ name: 'grok-agent-bridge', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(connectEndpoint(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: fetchFn });
    preferRequiredVersion(transport);
    try { await client.connect(transport, { timeout: 15000 }); return new McpConnection(client, 'http', transport, token); }
    catch (error) { await client.close().catch(() => {}); throw error; }
  }
  /** The official T3 CLI launcher receives authorization only through its child environment. */
  static async connectStdio(command: string, args: string[], env: Record<string, string>, token: string): Promise<McpConnection> {
    const client = new Client({ name: 'grok-agent-bridge', version: '0.1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' });
    preferRequiredVersion(transport);
    try { await client.connect(transport, { timeout: 15000 }); return new McpConnection(client, 'stdio', transport, token); }
    catch (error) { await client.close().catch(() => {}); throw error; }
  }
  static async connect(endpoint: string, token: string, legacyEndpoint = endpoint): Promise<McpConnection> {
    if (!token) throw new Error('MCP bearer token required');
    const url = loopbackUrl(endpoint), legacy = loopbackUrl(legacyEndpoint);
    if (legacy.origin !== url.origin) throw new Error('Legacy endpoint must share origin');
    const headers = { Authorization: `Bearer ${token}` };
    const safeFetch: typeof fetch = async (input, init) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('MCP headers timeout')), 15000);
      try { return await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }); }
      finally { clearTimeout(timer); }
    };
    const client = new Client({ name: 'grok-supervisor', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: safeFetch });
    preferRequiredVersion(transport);
    try { await client.connect(transport, { timeout: 15000 }); return new McpConnection(client, 'http', transport, token); }
    catch (error) {
      await transport.close().catch(() => {});
      // Never downgrade on authorization failures, timeouts or malformed protocols.
      if (!(error instanceof StreamableHTTPError) || error.code === undefined || ![404, 405].includes(error.code)) throw error;
      const fallback = new Client({ name: 'grok-supervisor', version: '0.1.0' }, { capabilities: {} });
      const sse = new SSEClientTransport(legacy, { requestInit: { headers }, fetch: safeFetch });
      preferRequiredVersion(sse);
      try { await fallback.connect(sse, { timeout: 15000 }); return new McpConnection(fallback, 'sse', sse, token); }
      catch (e) { await sse.close().catch(() => {}); throw e; }
    }
  }
  async call<T = any>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Native startup may negotiate several RPCs; owner verification itself has a 120s budget.
    const timeout = name === 'agent_verify' ? 300000 : ['agent_start', 'agent_attach', 'agent_resume', 'agent_followup'].includes(name) ? 600000 : 30000;
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout });
    if (result.isError) {
      const detail = name.startsWith('agent_') ? (result.content as any[]).filter(v => v.type === 'text' && typeof v.text === 'string').map(v => v.text).join('\n').slice(0, 2000) : '';
      throw new Error(`MCP tool failed: ${name}${detail ? ': ' + this.redactor.redact(detail) : ''}`);
    }
    if (result.structuredContent) return result.structuredContent as T;
    const text = (result.content as any[]).filter((v: any) => v.type === 'text').map((v: any) => v.text).join('\n');
    try { return JSON.parse(text) as T; } catch { throw new Error(`MCP ${name} returned no structured JSON result`); }
  }
  async close(): Promise<void> { if (this.transport instanceof StreamableHTTPClientTransport) await this.transport.terminateSession().catch(() => {}); await this.client.close(); }
}
export const t3Thread = z.object({ threadId: z.string(), status: z.string().nullable(), runId: z.string().nullable().optional(), modelSelection: z.object({ instanceId: z.string().optional(), model: z.string() }).passthrough().optional() }).passthrough();
