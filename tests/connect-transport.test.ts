import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpConnection } from '../src/adapters/mcp.js';
import { connectT3 } from '../src/connect/connection.js';
import { connectStatus } from '../src/connect/oauth.js';
import { credentialReference, type ConnectCredential, type ConnectCredentialStore } from '../src/connect/store.js';
import { connectT3Bridge } from '../src/bridge/t3-provider.js';

vi.mock('../src/connect/launcher.js', () => ({ discoverConnectLauncher: vi.fn(async () => undefined) }));
const endpoint = 'https://connect.example/mcp', credentialRef = credentialReference(endpoint), token = 'test-connect-bearer-secret';
function fixture() {
  let record: ConnectCredential = { version: 1, endpoint, accessToken: token, expiresAt: Date.now() + 100000, enrolledAt: Date.now(), clientInformation: {} };
  const store: ConnectCredentialStore = { async read() { return record; }, async write(_ref, value) { record = value; } };
  return { store, record };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('refuses expired and mismatched stored credentials before any transport starts', async () => {
  const { store, record } = fixture(); record.expiresAt = Date.now() - 1;
  const spy = vi.spyOn(McpConnection, 'connectRemote');
  await expect(connectT3({ endpoint, credentialRef, store })).rejects.toThrow('approval expired');
  await expect(connectT3({ endpoint, credentialRef: 'a'.repeat(64), store })).rejects.toThrow('endpoint mismatch');
  expect(spy).not.toHaveBeenCalled();
});

it('uses SDK HTTPS fallback with bearer headers and persistent 401 rejection, without refresh', async () => {
  const { store } = fixture();
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify({ error: token }), { status: 401 });
  }));
  await expect(connectT3({ endpoint, credentialRef, store })).rejects.toThrow('approval expired');
  expect((await connectStatus({ endpoint, credentialRef, store })).state).toBe('reauthorization_required');
  const calls = vi.mocked(fetch).mock.calls.length;
  await expect(connectT3({ endpoint, credentialRef, store })).rejects.toThrow('approval expired');
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
});

it('refuses cross-origin redirect without leaking the authorization error or attempting SSE', async () => {
  const { store } = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`secret downstream error: ${token}`); }));
  await expect(connectT3({ endpoint, credentialRef, store })).rejects.toThrow('https-sdk connection failed');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});

it('negotiates real SDK HTTPS MCP and invalidates a 401 received after initialization', async () => {
  const { store } = fixture();
  let rejectTool = false;
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    if (rejectTool && request.method === 'tools/call') return new Response('unauthorized', { status: 401 });
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { content: [], structuredContent: { ok: true } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
  }));
  const caller = await connectT3({ endpoint, credentialRef, store });
  try {
    expect(caller.transportKind).toBe('https-sdk');
    expect(await caller.call('probe', {})).toEqual({ ok: true });
    rejectTool = true;
    await expect(caller.call('probe', {})).rejects.toThrow('approval expired');
    expect((await connectStatus({ endpoint, credentialRef, store })).state).toBe('reauthorization_required');
  } finally { await caller.close(); }
});

it('rejects local/legacy/tokenEnv mixing in Connect configuration', async () => {
  await expect(connectT3Bridge({ projectId: 'p', endpoint, tokenEnv: 'TOKEN', connect: { credentialRef } })).rejects.toThrow('persisted credential');
  await expect(connectT3Bridge({ projectId: 'p', connect: { credentialRef } })).rejects.toThrow('explicit HTTPS');
});

it('launches the official stdio contract with authorization in child env only and discards child stderr', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'grok-connect-stdio-'));
  const script = join(temporary, 'official-contract-fixture.cjs');
  await writeFile(script, `const readline = require('node:readline');
const token = process.env.T3_ACP_MCP_AUTHORIZATION;
process.stderr.write(token + '\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line); if(msg.id===undefined)return;
 const result=msg.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'official-contract-fixture',version:'1'}}:
 {structuredContent:{envBearer: token==='Bearer test-connect-bearer-secret',endpoint:process.env.T3_ACP_MCP_ENDPOINT,argvSafe:!process.argv.some(v=>v.includes('test-connect-bearer-secret')),command:process.argv.at(-1)},content:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});`);
  try {
    const { store, record } = fixture();
    const caller = await connectT3({ endpoint, credentialRef, store, bridge: { command: process.execPath, args: [script] } });
    try {
      expect(caller.transportKind).toBe('official-stdio');
      expect(await caller.call('probe', {})).toEqual({ envBearer: true, endpoint, argvSafe: true, command: 'acp-mcp-bridge' });
      record.expiresAt = Date.now() - 1;
      await expect(caller.call('probe', {})).rejects.toThrow('approval expired');
    } finally { await caller.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it('does not leak child errors or retry a failing configured launcher through HTTPS', async () => {
  const { store } = fixture();
  vi.spyOn(McpConnection, 'connectStdio').mockRejectedValue(new Error(`child echoed ${token}`));
  const fallback = vi.spyOn(McpConnection, 'connectRemote');
  await expect(connectT3({ endpoint, credentialRef, store, bridge: { command: 'missing-t3' } })).rejects.toThrow('official-stdio connection failed');
  expect(fallback).not.toHaveBeenCalled();
});

it('invalidates an approval rejected by the official bridge during initialization', async () => {
  const { store } = fixture();
  vi.spyOn(McpConnection, 'connectStdio').mockRejectedValue(new Error('T3 Code MCP endpoint responded with HTTP 401.'));
  await expect(connectT3({ endpoint, credentialRef, store, bridge: { command: 't3' } })).rejects.toThrow('approval expired');
  expect((await connectStatus({ endpoint, credentialRef, store })).state).toBe('reauthorization_required');
});
