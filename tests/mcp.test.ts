import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { serveHttp } from '../src/server.js';
import { McpConnection, discoverT3, loopbackUrl } from '../src/adapters/mcp.js';
import { Redactor } from '../src/safety.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { GrokReasoner } from '../src/grok.js';

describe('real MCP loopback HTTP and legacy SSE', () => {
  const token = 'test-token-at-least-24-characters';
  let host: Awaited<ReturnType<typeof serveHttp>>;
  beforeAll(async () => { host = await serveHttp({ repository: process.cwd(), redactor: new Redactor() }, token); });
  afterAll(async () => { await host.close(); });
  it.each(['2025-06-18', '2024-11-05'])('negotiates protocol %s using actual initialize frames', async version => {
    const response = await fetch(host.url + '/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    });
    expect(response.status).toBe(200);
    const body = await response.text(); expect(body).toContain(`"protocolVersion":"${version}"`);
  });
  it('calls a tool over Streamable HTTP and returns deterministic denial', async () => {
    const connection = await McpConnection.connect(host.url + '/mcp', token);
    try {
      expect(connection.transportKind).toBe('http');
      const verdict = await connection.call('permission_evaluate', { command: 'rm -rf /', cwd: process.cwd() });
      expect(verdict).toMatchObject({ allow: false, risk: 'blocked' });
    } finally { await connection.close(); }
  });
  it('falls back on 404/405 to authenticated legacy SSE, including POSTs', async () => {
    const connection = await McpConnection.connect(host.url + '/sse', token);
    try {
      expect(connection.transportKind).toBe('sse');
      const verdict = await connection.call('permission_evaluate', { executable: 'git', args: ['status', '--short'], cwd: process.cwd() });
      expect(verdict.allow).toBe(true);
    } finally { await connection.close(); }
  });
  it('refuses authentication failures, hostile origins, DNS rebinding, and malformed JSON', async () => {
    await expect(McpConnection.connect(host.url + '/mcp', 'wrong')).rejects.toThrow();
    expect((await fetch(host.url + '/mcp', { headers: { Origin: 'https://evil.invalid', Authorization: `Bearer ${token}` } })).status).toBe(403);
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(host.url + '/mcp', { headers: { Host: 'evil.invalid', Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
    });
    expect(rebinding).toBe(403);
    const bad = await fetch(host.url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{secret' });
    expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('secret');
  });
  it('rejects unsupported arguments and reports missing Grok honestly', async () => {
    const connection = await McpConnection.connect(host.url + '/mcp', token);
    try {
      await expect(connection.call('permission_evaluate', { cwd: 123 })).rejects.toThrow('MCP tool failed');
      await expect(connection.call('question_resolve', { question: 'q', context: '' })).rejects.toThrow('MCP tool failed');
    } finally { await connection.close(); }
  });
});
it('discovers current T3 runtime shape and refuses nonloopback endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-discover-')), path = join(directory, 'runtime.json');
  try {
    await writeFile(path, JSON.stringify({ version: 1, origin: 'http://127.0.0.1:1234' }));
    expect(await discoverT3(path)).toEqual({ endpoint: 'http://127.0.0.1:1234/mcp' });
    expect(() => loopbackUrl('https://evil.invalid/mcp')).toThrow('loopback');
  } finally { await rm(directory, { recursive: true }); }
});
it('propagates HTTP request cancellation to the active task', async () => {
  let runningSignal: AbortSignal | undefined;
  let started!: () => void; const start = new Promise<void>(r => { started = r; });
  const host = await serveHttp({ repository: process.cwd(), redactor: new Redactor(), run: async (_goal, signal) => {
    runningSignal = signal; started();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { state: 'stopped', turns: 0, reason: 'cancelled', worktree: process.cwd() };
  } }, 'test-token-at-least-24-characters');
  const connection = await McpConnection.connect(host.url + '/mcp', 'test-token-at-least-24-characters');
  try {
    const abort = new AbortController();
    const result = connection.call('supervisor_run', { goal: 'test' }, abort.signal);
    const rejected = expect(result).rejects.toThrow();
    await start; abort.abort(new Error('owner stopped task')); await rejected;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(runningSignal?.aborted).toBe(true);
  } finally { await connection.close(); await host.close(); }
});
it('releases failed initialize requests before the session cap is exhausted', async () => {
  const token = 'test-token-at-least-24-characters';
  const host = await serveHttp({ repository: process.cwd(), redactor: new Redactor() }, token);
  try {
    for (let i = 0; i < 17; i++) {
      const response = await fetch(host.url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize', params: {} }) });
      expect(response.status).toBe(400); await response.body?.cancel();
    }
    const connection = await McpConnection.connect(host.url + '/mcp', token); await connection.close();
  } finally { await host.close(); }
});
it('never exposes provider error text or malformed decision fragments through MCP', async () => {
  const secret = 'customer-sensitive-credential';
  const reasoner = new GrokReasoner('key', 'model', new Redactor([secret]), async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: secret }] }] }));
  await expect(reasoner.answer('q', '')).rejects.toThrow('Malformed Grok decision');
  const host = await serveHttp({ repository: process.cwd(), redactor: new Redactor([secret]), reasoner: { ...reasoner, answer: async () => { throw new Error(secret); }, evaluate: reasoner.evaluate.bind(reasoner) } }, 'test-token-at-least-24-characters');
  const connection = await McpConnection.connect(host.url + '/mcp', 'test-token-at-least-24-characters');
  try {
    const result = await connection.client.callTool({ name: 'question_resolve', arguments: { question: 'q', context: '' } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('customer');
  } finally { await connection.close(); await host.close(); }
});
