import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { serveRemote } from '../src/remote/http.js';

const token = 'owned-test-token-with-more-than-32-characters';
const origin = 'https://bridge.example.invalid';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
function factory() {
  const server = new Server({ name: 'remote-test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'agent_test', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'native-proxy-result' }] }));
  return server;
}
async function raw(url: string, extra: Record<string, string>) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: { ...headers, ...extra } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
}
describe('standalone remote HTTP boundary', () => {
  it('binds every session to its OAuth client and rechecks token scope and expiry', async () => {
    let closed = 0;
    const host = await serveRemote({ origin, token, oauth: { router: express.Router(), verify: async supplied => ({
      token: supplied, clientId: supplied === 'client-b' ? 'b' : 'a', scopes: supplied === 'no-scope' ? [] : ['coding:operate'],
      expiresAt: supplied === 'expired' ? 1 : Math.floor(Date.now() / 1000) + 300, resource: new URL(origin + '/mcp')
    }) }, createServer: () => { const server = factory(); server.onclose = () => { closed++; }; return server; } });
    try {
      const ownerHeaders = { ...headers, Authorization: 'Bearer client-a' };
      const initialized = await fetch(host.url + '/mcp', { method: 'POST', headers: ownerHeaders, body: JSON.stringify(initialize) });
      expect(initialized.status).toBe(200); await initialized.text();
      const id = initialized.headers.get('mcp-session-id')!;
      for (const method of ['GET', 'POST', 'DELETE']) {
        const stolen = await fetch(host.url + '/mcp', { method, headers: { ...headers, Authorization: 'Bearer client-b', 'mcp-session-id': id } });
        expect(stolen.status).toBe(403); expect(closed).toBe(0);
      }
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': id } })).status).toBe(403);
      for (const invalid of ['no-scope', 'expired']) expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, Authorization: `Bearer ${invalid}`, 'mcp-session-id': id } })).status).toBe(401);
      expect(closed).toBe(0);
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...ownerHeaders, 'mcp-session-id': id } })).status).toBe(200);
      expect(closed).toBe(1);
    } finally { await host.close(); }
  });
  it('exposes OAuth metadata before bearer auth but authenticates every MCP method and passes verified context', async () => {
    const router = express.Router();
    router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => { res.json({ resource: origin + '/mcp' }); });
    const verify = vi.fn(async (supplied: string) => {
      if (supplied !== 'valid-oauth-access-token') throw new Error('secret internal scope/audience diagnostic');
      return { token: supplied, clientId: 'enrolled-client', scopes: ['coding:operate'], resource: new URL(origin + '/mcp') };
    });
    const host = await serveRemote({ origin, token, oauth: { router, verify }, createServer: () => {
      const server = factory();
      server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => ({ content: [{ type: 'text', text: extra.authInfo?.clientId ?? 'private-owner' }] }));
      return server;
    } });
    const client = new Client({ name: 'oauth-client', version: '1' });
    try {
      expect((await fetch(host.url + '/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
      expect(await raw(host.url + '/.well-known/oauth-protected-resource/mcp', { Host: 'untrusted.invalid' })).toBe(403);
      expect(await raw(host.url + '/.well-known/oauth-protected-resource/mcp', { Origin: 'https://untrusted.invalid' })).toBe(403);
      for (const method of ['GET', 'POST', 'DELETE']) {
        const unauth = await fetch(host.url + '/mcp', { method });
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        const rejected = await fetch(host.url + '/mcp', { method, headers: { Authorization: 'Bearer wrong-scope-or-audience' } });
        expect(rejected.status).toBe(401); expect(await rejected.text()).not.toContain('diagnostic');
      }
      expect((await fetch(host.url + '/not-an-oauth-route')).status).toBe(404);
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer valid-oauth-access-token' } } }));
      expect((await client.callTool({ name: 'agent_test', arguments: {} })).content).toEqual([{ type: 'text', text: 'enrolled-client' }]);
      const beforePrivate = verify.mock.calls.length;
      expect(await raw(host.url + '/mcp', {})).toBe(405);
      expect(verify.mock.calls.length).toBe(beforePrivate);
    } finally { await client.close(); await host.close(); }
  });
  it('expires idle sessions using an unreferenced bounded timer', async () => {
    let expiry: (() => void) | undefined, timer: NodeJS.Timeout | undefined, closed = 0;
    const originalTimeout = globalThis.setTimeout;
    const host = await serveRemote({ origin, token, createServer: () => { const server = factory(); server.onclose = () => { closed++; }; return server; } });
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const scheduled = originalTimeout(callback, delay, ...args);
      if (delay === 3_600_000) { expiry = () => callback(...args); timer = scheduled; }
      return scheduled;
    }) as typeof setTimeout);
    try {
      const response = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(response.status).toBe(200); await response.text();
      expect(timer?.hasRef()).toBe(false); expect(expiry).toBeTypeOf('function');
      expiry!();
      expect(closed).toBe(1);
      expect((await fetch(host.url + '/mcp', { headers: { ...headers, 'mcp-session-id': response.headers.get('mcp-session-id')! } })).status).toBe(404);
    } finally { spy.mockRestore(); await host.close(); }
  });
  it('serves real SDK initialize, discovery, and tool calls, with loopback-only binding', async () => {
    const host = await serveRemote({ origin, token, createServer: factory });
    const client = new Client({ name: 'remote-client', version: '1' });
    try {
      expect(host.server.address()).toMatchObject({ address: '127.0.0.1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: origin } } }));
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['agent_test']);
      expect((await client.callTool({ name: 'agent_test', arguments: {} })).content).toEqual([{ type: 'text', text: 'native-proxy-result' }]);
    } finally { await client.close(); await host.close(); await host.close(); }
  });
  it('authenticates before parsing and rejects host, origin, route and forwarding tricks', async () => {
    let created = 0;
    const host = await serveRemote({ origin, token, createServer: () => { created++; return factory(); } });
    try {
      expect(await raw(host.url + '/mcp', { Authorization: '' })).toBe(401);
      expect(await raw(host.url + '/mcp', { Authorization: `Bearer ${token}extra` })).toBe(401);
      expect(await raw(host.url + '/mcp', { Host: 'attacker.invalid', 'X-Forwarded-Host': 'bridge.example.invalid' })).toBe(403);
      expect(await raw(host.url + '/mcp', { Origin: 'https://attacker.invalid' })).toBe(403);
      expect(await raw(host.url + '/mcp', { Origin: 'null' })).toBe(403);
      expect(await raw(host.url + '/mcp', { Host: 'bridge.example.invalid' })).toBe(405);
      expect(await raw(host.url + '/mcp/', {})).toBe(404);
      expect(await raw(host.url + '/mcp?secret=hidden', {})).toBe(404);
      expect(await raw(host.url + '/sse', {})).toBe(404);
      const unauth = await fetch(host.url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{secret' });
      expect(unauth.status).toBe(401); expect(await unauth.text()).not.toContain('secret');
      const oversized = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ secret: 'x'.repeat(65_536) }) });
      expect(oversized.status).toBe(413); expect(await oversized.text()).toBe('{"error":"Invalid request"}');
      const malformed = await fetch(host.url + '/mcp', { method: 'POST', headers, body: '{secret' });
      expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain('secret');
      expect(created).toBe(0);
    } finally { await host.close(); }
  });
  it('caps sessions per principal and lets the owner reclaim the least-recently-active foreign session', async () => {
    let closed = 0;
    const host = await serveRemote({ origin, token, oauth: { router: express.Router(), verify: async supplied => ({
      token: supplied, clientId: supplied === 'client-b' ? 'b' : 'a', scopes: ['coding:operate'], resource: new URL(origin + '/mcp')
    }) }, createServer: () => { const server = factory(); server.onclose = () => { closed++; }; return server; } });
    const open = async (authorization: string) => {
      const response = await fetch(host.url + '/mcp', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${authorization}` }, body: JSON.stringify(initialize) });
      expect(response.status).toBe(200); const id = response.headers.get('mcp-session-id')!; await response.text(); return id;
    };
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    try {
      const own: string[] = [];
      for (let i = 0; i < 8; i++) own.push(await open(token));
      // Eight live sessions are the per-principal budget, even for the private owner.
      expect((await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) })).status).toBe(429);
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': own[0]! } })).status).toBe(200);
      const foreign: string[] = [];
      for (let i = 0; i < 8; i++) foreign.push(await open('client-a'));
      const other = await open('client-b');
      // The table is full (7 owner + 8 client-a + 1 client-b). Refresh client-a's
      // oldest session so FIFO eviction would pick foreign[0]; the LRU eviction
      // must skip it and take foreign[1].
      const refreshed = await fetch(host.url + '/mcp', { method: 'POST', headers: { ...headers, Authorization: 'Bearer client-a', 'mcp-session-id': foreign[0]! }, body: JSON.stringify(list) });
      expect(refreshed.status).toBe(200); await refreshed.text();
      expect(await open(token)).toBeTruthy();
      // Other principals cannot displace anyone at the global cap.
      expect((await fetch(host.url + '/mcp', { method: 'POST', headers: { ...headers, Authorization: 'Bearer client-a' }, body: JSON.stringify(initialize) })).status).toBe(429);
      expect((await fetch(host.url + '/mcp', { method: 'POST', headers: { ...headers, Authorization: 'Bearer client-b' }, body: JSON.stringify(initialize) })).status).toBe(429);
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, Authorization: 'Bearer client-a', 'mcp-session-id': foreign[1]! } })).status).toBe(404);
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, Authorization: 'Bearer client-a', 'mcp-session-id': foreign[0]! } })).status).toBe(200);
    } finally { await host.close(); }
    expect(closed).toBe(18);
  });
  it('releases malformed initialization and factory failures without leaking errors', async () => {
    let fail = true;
    const host = await serveRemote({ origin, token, createServer: () => { if (fail) throw new Error('credential-secret'); return factory(); } });
    try {
      const failed = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(failed.status).toBe(500); expect(await failed.text()).not.toContain('credential-secret'); fail = false;
      for (let i = 0; i < 17; i++) {
        const invalid = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ ...initialize, params: {} }) });
        expect(invalid.status).toBe(400); await invalid.text();
      }
      const valid = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(valid.status).toBe(200); await valid.text();
    } finally { await host.close(); }
  });
  it.each(['http://host.invalid', 'https://user:pass@host.invalid', 'https://host.invalid/mcp', 'https://host.invalid/?x=1', 'https://host.invalid/#x', 'https://host.invalid/path/..'])('rejects invalid public origin %s', async value => {
    await expect(serveRemote({ origin: value, token, createServer: factory })).rejects.toThrow();
  });
});
