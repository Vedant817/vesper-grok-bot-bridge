import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bridgeApplication } from '../src/bridge/application.js';
import { serveHttp } from '../src/server.js';
import { McpConnection } from '../src/adapters/mcp.js';
import { git } from '../src/worktree.js';

it.each(['/mcp', '/sse'])('exposes the actual bridge workflow over %s without an xAI key', async endpoint => {
  const base = await mkdtemp(join(tmpdir(), 'bridge-mcp-')), repository = join(base, 'repository');
  await mkdir(repository); await git(repository, ['init']); await git(repository, ['config', 'user.name', 'Bridge Test']); await git(repository, ['config', 'user.email', 'bridge@example.invalid']);
  await writeFile(join(repository, 'README.md'), 'fixture'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'fixture']);
  const secret = 'unique-unstructured-owner-value-927441';
  const fixture = { executable: process.execPath, protocol: 'acp', models: ['fixture'], args: [resolve('tests/fixtures/acp-agent.mjs')] };
  const services = await bridgeApplication({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'console.log(process.env.OWNER_TEST_VALUE)'], env: { OWNER_TEST_VALUE: secret } } }], providers: { codex: fixture, opencode: fixture, claude: fixture } });
  const token = 'test-bridge-token-at-least-24-characters', host = await serveHttp(services, token);
  const client = await McpConnection.connect(host.url + endpoint, token, host.url + endpoint);
  try {
    const tools = await client.client.listTools();
    expect(tools.tools.some(t => t.name === 'agent_attach')).toBe(true);
    expect(['agent_dispatch', 'agent_monitor', 'agent_wait'].every(name => tools.tools.some(t => t.name === name))).toBe(true);
    expect(tools.tools.some(t => t.name === 'question_resolve')).toBe(false);
    const catalog = await client.call<any[]>('agent_discover', {}); expect(catalog.find(p => p.id === 'codex')?.models).toEqual(['fixture']);
    const input = { provider: 'codex', model: 'fixture', directory: repository, task: 'Inspect fixture', requestId: 'stable-request' };
    await expect(client.call('agent_start', { ...input, model: 'unavailable' })).rejects.toThrow('Requested model');
    const session = await client.call<any>('agent_start', input);
    expect((await client.call<any>('agent_start', input)).id).toBe(session.id);
    const waitFor = async (status: string) => {
      for (let i = 0; i < 100; i++) { const value = await client.call<any>('agent_read', { sessionId: session.id }); if (value.status === status) return value; await new Promise(r => setTimeout(r, 10)); }
      throw new Error(`Session did not reach ${status}`);
    };
    const pending = await waitFor('awaiting_input'); expect(pending.pending[0].type).toBe('permission');
    const dispatched = await client.call<any>('agent_dispatch', { taskKey: 'fixture-task', requestId: 'bind-existing', provider: 'codex', model: 'fixture', directory: repository, instruction: 'Continue after approval', sessionId: session.id });
    expect(dispatched.instructionSubmitted).toBe(false); expect(dispatched.session.id).toBe(session.id);
    const observed = await client.call<any[]>('agent_monitor', {}); expect(observed.find(s => s.id === session.id)?.pending).toHaveLength(1);
    const waiting = await client.call<any>('agent_wait', { sessionId: session.id, afterCursor: pending.cursor, timeoutMs: 20 }); expect(waiting.status).toBe('awaiting_input');
    await client.call('agent_respond', { sessionId: session.id, requestId: pending.pending[0].id, allow: false });
    await waitFor('awaiting_review');
    const evidence = await client.call<any>('agent_verify', { sessionId: session.id });
    expect(evidence.passed).toBe(true); expect(evidence.output).toContain('REDACTED'); expect(evidence.output).not.toContain(secret);
    const result = await client.call<any>('agent_finish', { sessionId: session.id, evidenceId: evidence.id }); expect(result.status).toBe('finished');
    await new Promise(r => setTimeout(r, 20)); expect((await client.call<any>('agent_read', { sessionId: session.id })).status).toBe('finished');
  } finally { await client.close(); await services.bridge.close(); await host.close(); await rm(base, { recursive: true, force: true }); }
}, 20000);
