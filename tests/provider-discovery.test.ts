import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeAcp } from '../src/bridge/acp-discovery.js';
import { discoverProviders, resolveExecutable, type ProviderOverride } from '../src/bridge/provider.js';
import type { RpcMessage, Wire } from '../src/rpc.js';

class ProbeWire implements Wire {
  messages: RpcMessage[] = []; closed = 0;
  onMessage?: (message: RpcMessage) => void;
  onClose?: (error: Error) => void;
  constructor(private readonly result: unknown = { protocolVersion: 1 }) {}
  send(message: RpcMessage): void {
    this.messages.push(message);
    if (message.method === 'initialize' && this.result !== undefined) queueMicrotask(() => this.onMessage?.({ id: message.id, result: this.result }));
  }
  close(): void { this.closed++; }
}

describe('initialize-only ACP discovery', () => {
  it('reports advertised protocol/auth capabilities without authenticating or creating sessions', async () => {
    const wire = new ProbeWire({ protocolVersion: 1, agentInfo: { name: 'Example ACP', version: '1.2.3' }, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'native_login', name: 'Native login' }] });
    expect(await probeAcp(() => wire)).toEqual({ protocolVersion: 1, agentInfo: { name: 'Example ACP', version: '1.2.3' }, capabilities: { loadSession: true }, authMethods: [{ id: 'native_login', name: 'Native login' }], authentication: 'not_checked' });
    expect(wire.messages.map(message => message.method)).toEqual(['initialize']); expect(wire.closed).toBe(1);
  });
  it('rejects unsupported versions and closes the transport', async () => {
    const wire = new ProbeWire({ protocolVersion: 2 });
    await expect(probeAcp(() => wire)).rejects.toThrow('Unsupported ACP'); expect(wire.closed).toBe(1);
  });
  it('rejects malformed auth metadata and does not copy arbitrary agent data', async () => {
    const wire = new ProbeWire({ protocolVersion: 1, authMethods: [{ name: 'missing id' }] });
    await expect(probeAcp(() => wire)).rejects.toThrow('authentication metadata'); expect(wire.closed).toBe(1);
    const safe = await probeAcp(() => new ProbeWire({ protocolVersion: 1, agentInfo: { name: 'Example', token: 'private' }, secret: 'private', authMethods: [{ id: 'native', name: 'token=xai-1234567890123456', token: 'private' }] }));
    expect(JSON.stringify(safe)).not.toContain('private'); expect(safe.authMethods[0].name).toContain('[REDACTED]');
  });
  it('bounds silent probes and closes their transports', async () => {
    const wire = new ProbeWire(null); wire.send = message => { wire.messages.push(message); };
    await expect(probeAcp(() => wire, 5)).rejects.toThrow('RPC timeout: initialize'); expect(wire.closed).toBe(1);
  });
  it('does not service filesystem or auth requests during a probe', async () => {
    const wire = new ProbeWire(); const original = wire.send.bind(wire);
    wire.send = message => { original(message); if (message.method === 'initialize') wire.onMessage?.({ jsonrpc: '2.0', id: 'server-read', method: 'fs/read_text_file', params: { path: 'credential' } }); };
    await probeAcp(() => wire);
    expect(wire.messages.find(message => message.id === 'server-read')).toMatchObject({ error: { code: -32601 } });
    expect(wire.closed).toBe(1);
  });
});

describe('owner-configured provider discovery', () => {
  let temporary: string | undefined;
  afterEach(async () => { vi.unstubAllEnvs(); if (temporary) await rm(temporary, { recursive: true, force: true }); });
  const disabled = (directory: string): Record<string, ProviderOverride> => Object.fromEntries(['codex', 'claude', 'opencode', 'grok-build'].map(id => [id, { executable: join(directory, 'not-installed.exe') }]));
  async function fixture(protocolVersion = 1): Promise<{ script: string; log: string }> {
    temporary = await mkdtemp(join(tmpdir(), 'provider-discovery-'));
    const script = join(temporary, 'owner-agent.mjs'), log = join(temporary, 'calls.jsonl');
    await writeFile(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const log=${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({argv:process.argv.slice(2)})+'\\n');
createInterface({input:process.stdin}).on('line', line=>{const m=JSON.parse(line); appendFileSync(log,JSON.stringify({method:m.method})+'\\n'); if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:${protocolVersion},agentInfo:{name:'Owner ACP'},authMethods:[{id:'cached_token'}]}})+'\\n');});`);
    return { script, log };
  }
  it('keeps a custom ACP label and probes only initialization using exact owner argv', async () => {
    const { script, log } = await fixture();
    const providers = await discoverProviders({ ...disabled(temporary!), custom: { executable: process.execPath, args: [script, 'prefix with spaces', 'literal&argument'], protocol: 'acp', models: ['exact'] } });
    const custom = providers.find(provider => provider.id === 'custom')!;
    expect(custom).toMatchObject({ label: 'custom', available: true, protocol: 'acp', models: ['exact'], acp: { authentication: 'not_checked', authMethods: [{ id: 'cached_token' }] } });
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toEqual([{ argv: ['prefix with spaces', 'literal&argument'] }, { method: 'initialize' }]);
    expect(() => custom.create({ model: 'substitute' })).toThrow('Requested model unavailable');
  });
  it('uses supervised private Grok Build ACP argv, without leader sharing or automatic approval', async () => {
    const { script, log } = await fixture();
    const providers = await discoverProviders({ ...disabled(temporary!), 'grok-build': { executable: script } });
    expect(providers.find(provider => provider.id === 'grok-build')).toMatchObject({ label: 'Grok Build', available: true, protocol: 'acp', models: [] });
    expect(JSON.parse((await readFile(log, 'utf8')).split('\n')[0]).argv).toEqual(['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
  });
  it('does not run a native model-list command against a provider overridden to ACP', async () => {
    const { script, log } = await fixture();
    const providers = await discoverProviders({ ...disabled(temporary!), codex: { executable: script, protocol: 'acp' } });
    expect(providers.find(provider => provider.id === 'codex')).toMatchObject({ available: true, protocol: 'acp', models: [] });
    expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{ argv: ['acp'] }, { method: 'initialize' }]);
  });
  it('marks a found non-ACP executable unavailable instead of treating existence as readiness', async () => {
    const { script } = await fixture(42);
    const providers = await discoverProviders({ ...disabled(temporary!), custom: { executable: script, args: [], protocol: 'acp' } });
    const custom = providers.find(provider => provider.id === 'custom')!;
    expect(custom).toMatchObject({ available: false, protocol: 'acp', reason: expect.stringContaining('ACP initialization failed') });
    expect(() => custom.create({ model: 'any' })).toThrow('ACP initialization');
    expect(providers.find(provider => provider.id === 'antigravity')?.reason).toContain('owner-enrolled standalone ACP');
  });
  it('resolves installed Grok native fallback without accepting Windows command scripts', async () => {
    // Test only owned files; do not create or modify a real installation.
    temporary = await mkdtemp(join(tmpdir(), 'provider-resolve-'));
    vi.stubEnv('USERPROFILE', temporary); vi.stubEnv('HOME', temporary); vi.stubEnv('PATH', temporary); vi.stubEnv('Path', temporary);
    const bin = join(temporary, '.grok', 'bin'); await mkdir(bin, { recursive: true });
    const executable = join(bin, process.platform === 'win32' ? 'grok.exe' : 'grok'); await writeFile(executable, 'fixture', { mode: 0o700 });
    expect(await resolveExecutable('grok')).toEqual({ executable: resolve(executable), args: [] });
    const wrapper = join(temporary, 'grok.cmd'); await writeFile(wrapper, '@echo forbidden');
    if (process.platform === 'win32') expect(await resolveExecutable(wrapper)).toBeUndefined();
  });
});
