import { describe, expect, it } from 'vitest';
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
  it('caps live sessions and releases them through explicit termination and close', async () => {
    let closed = 0;
    const host = await serveRemote({ origin, token, createServer: () => { const server = factory(); server.onclose = () => { closed++; }; return server; } });
    const ids: string[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const response = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
        expect(response.status).toBe(200); ids.push(response.headers.get('mcp-session-id')!); await response.text();
      }
      const capped = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(capped.status).toBe(429);
      expect((await fetch(host.url + '/mcp', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': ids[0]! } })).status).toBe(200);
      const replacement = await fetch(host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(replacement.status).toBe(200); await replacement.text();
      expect((await fetch(host.url + '/mcp', { headers: { ...headers, 'mcp-session-id': ids[0]! } })).status).toBe(404);
    } finally { await host.close(); }
    expect(closed).toBe(17);
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
