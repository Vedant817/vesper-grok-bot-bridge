import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fake = vi.hoisted(() => ({ release: vi.fn(), assert: vi.fn(), probe: vi.fn(), start: vi.fn(), stop: vi.fn(), call: vi.fn(), resolve: vi.fn(), failRename: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (fake.failRename) { fake.failRename = false; throw new Error('Simulated publication failure'); }
    return actual.rename(from, to);
  } };
});
vi.mock('../src/managed/install.js', () => ({ acquireSetupLock: async () => ({ release: fake.release }), assertManageableDaemon: fake.assert }));
vi.mock('../src/managed/runtime.js', () => ({ startManaged: fake.start, stopManaged: fake.stop, callManaged: fake.call }));
vi.mock('../src/bridge/acp-discovery.js', () => ({ probeAcp: fake.probe }));
vi.mock('../src/bridge/provider.js', async original => ({ ...await original<typeof import('../src/bridge/provider.js')>(), resolveExecutable: fake.resolve }));
import { providerCli, parseProviderOptions } from '../src/provider-cli.js';
let home: string, previous: string;
beforeEach(async () => {
  vi.clearAllMocks(); fake.failRename = false; home = await mkdtemp(join(tmpdir(), 'provider-cli-'));
  previous = JSON.stringify({ stateDirectory: join(home, 'state'), roots: [{ directory: home, verify: { executable: process.execPath, args: ['check'], env: { SECRET: 'owner-secret' } } }], maxTurns: 3, providers: { existing: { executable: process.execPath, protocol: 'acp', env: { TOKEN: 'private-token' } } }, t3: { projectId: 'original' } }, null, 3);
  await writeFile(join(home, 'owner.json'), previous);
  fake.assert.mockResolvedValue('stopped'); fake.resolve.mockResolvedValue({ executable: process.execPath, args: [] });
  fake.probe.mockResolvedValue({ protocolVersion: 1, authMethods: [{ id: 'cached' }], authentication: 'not_checked' });
  fake.start.mockResolvedValue({}); fake.stop.mockResolvedValue(undefined); fake.call.mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
const add = (...extra: string[]) => ['provider', 'add', '--home', home, '--id', 'fixture', '--command', process.execPath, '--args', '["adapter.mjs","acp"]', ...extra];
const contents = () => readFile(join(home, 'owner.json'), 'utf8');
it('publishes ACP enrollment preserving every existing owner field and no authentication', async () => {
  expect(await providerCli(add('--models', '["exact-model"]', '--auth-method', 'cached'))).toBe(true);
  const saved = JSON.parse(await contents()), original = JSON.parse(previous);
  expect(saved).toEqual({ ...original, providers: { ...original.providers, fixture: { executable: process.execPath, args: ['adapter.mjs', 'acp'], protocol: 'acp', models: ['exact-model'], authMethodId: 'cached' } } });
  expect(fake.probe).toHaveBeenCalledOnce(); expect(fake.start).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledOnce();
  expect((await readdir(home)).filter(file => file.endsWith('.tmp'))).toEqual([]);
});
it('does not probe or mutate when ownership is unverified', async () => {
  fake.assert.mockRejectedValueOnce(new Error('unverified owner'));
  await expect(providerCli(add())).rejects.toThrow('unverified');
  expect(fake.probe).not.toHaveBeenCalled(); expect(await contents()).toBe(previous); expect(fake.release).toHaveBeenCalledOnce();
});
it('does not publish or stop when the protocol handshake fails', async () => {
  fake.probe.mockRejectedValueOnce(new Error('Unsupported ACP protocol version: provider-secret'));
  await expect(providerCli(add())).rejects.toThrow('initialize-only probe failed');
  expect(await contents()).toBe(previous); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledOnce();
});
it('rejects an unadvertised authentication method without modifying config', async () => {
  await expect(providerCli(add('--auth-method', 'invented'))).rejects.toThrow('not advertised'); expect(await contents()).toBe(previous); expect(fake.stop).not.toHaveBeenCalled();
});
it('refuses conflicting provider ids and skips probe/restart on exact idempotent input', async () => {
  await providerCli(add('--models', '["exact"]'));
  const first = await contents(); vi.clearAllMocks();
  await expect(providerCli(add('--models', '["other"]'))).rejects.toThrow('different configuration');
  expect(fake.probe).not.toHaveBeenCalled();
  await expect(providerCli(add('--models', '["exact"]'))).resolves.toBe(true);
  expect(fake.probe).not.toHaveBeenCalled(); expect(fake.start).not.toHaveBeenCalled(); expect(await contents()).toBe(first);
});
it('refuses even an idle running daemon without inspecting, probing, stopping or rewriting it', async () => {
  fake.assert.mockResolvedValue('running');
  await expect(providerCli(add())).rejects.toThrow('Stop the bridge before changing provider configuration');
  expect(fake.probe).not.toHaveBeenCalled(); expect(fake.call).not.toHaveBeenCalled(); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.start).not.toHaveBeenCalled(); expect(await contents()).toBe(previous); expect(fake.release).toHaveBeenCalledOnce();
});
it('rechecks ownership after probing and refuses a daemon that appeared during probe', async () => {
  fake.assert.mockResolvedValueOnce('stopped').mockResolvedValueOnce('running');
  await expect(providerCli(add())).rejects.toThrow('Daemon state changed'); expect(fake.probe).toHaveBeenCalledOnce(); expect(fake.stop).not.toHaveBeenCalled(); expect(await contents()).toBe(previous);
});
it('does not restart the daemon after a successful enrollment', async () => {
  await providerCli(add()); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.start).not.toHaveBeenCalled(); expect(fake.call).not.toHaveBeenCalled();
  expect(vi.mocked(console.log).mock.calls.flat().join('')).toContain('"daemonRestarted":false');
});
it('restores exact owner bytes if atomic publication fails and removes temporary files', async () => {
  fake.failRename = true;
  await expect(providerCli(add())).rejects.toThrow('Provider publication failed; previous configuration restored');
  expect(await contents()).toBe(previous); expect(await readdir(home)).toEqual(['owner.json']); expect(fake.release).toHaveBeenCalledOnce(); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.start).not.toHaveBeenCalled();
});
it('preserves invalid owner state without probing or repairing it', async () => {
  await writeFile(join(home, 'owner.json'), '{truncated');
  await expect(providerCli(add())).rejects.toThrow(); expect(await contents()).toBe('{truncated'); expect(fake.probe).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledOnce();
});
it('lists metadata without environment secrets, executable arguments, or owner credentials', async () => {
  await expect(providerCli(['provider', 'list', '--home', home])).resolves.toBe(true);
  const output = vi.mocked(console.log).mock.calls.flat().join('');
  expect(JSON.parse(output)).toEqual([{ id: 'existing', protocol: 'acp', models: [], authentication: 'not_checked' }]);
  expect(output).not.toMatch(/private-token|owner-secret|executable|env/); expect(fake.assert).not.toHaveBeenCalled(); expect(fake.probe).not.toHaveBeenCalled(); expect(await contents()).toBe(previous);
});
it('validates syntax, native commands, safe ids and JSON before lock or probe', async () => {
  expect(() => parseProviderOptions(['--token', 'secret'])).toThrow('Unknown');
  expect(() => parseProviderOptions(['--id', 'a', '--id', 'b'])).toThrow('duplicate');
  expect(() => parseProviderOptions(['--home', 'relative'])).toThrow('absolute');
  await expect(providerCli(add('--unknown', 'x'))).rejects.toThrow('Unknown');
  const invalidCommand = add(); invalidCommand[invalidCommand.indexOf('--command') + 1] = join(home, 'wrapper.CMD');
  await expect(providerCli(invalidCommand)).rejects.toThrow('native executable');
  const unsafe = add(); unsafe[unsafe.indexOf('--id') + 1] = '__proto__'; await expect(providerCli(unsafe)).rejects.toThrow();
  const malformed = add(); malformed[malformed.indexOf('--args') + 1] = '{"not":"array"}'; await expect(providerCli(malformed)).rejects.toThrow();
  expect(fake.probe).not.toHaveBeenCalled(); expect(fake.release).not.toHaveBeenCalled(); expect(await contents()).toBe(previous);
  expect(await providerCli(['unrelated'])).toBe(false);
});
