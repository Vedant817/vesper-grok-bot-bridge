import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fake = vi.hoisted(() => ({ release: vi.fn(), assert: vi.fn(), enroll: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../src/managed/install.js', () => ({ acquireSetupLock: async () => ({ release: fake.release }), assertManageableDaemon: fake.assert }));
vi.mock('../src/managed/runtime.js', () => ({ startManaged: fake.start, stopManaged: fake.stop }));
vi.mock('../src/connect/index.js', async original => ({ ...await original<typeof import('../src/connect/index.js')>(), enrollConnect: fake.enroll }));
import { connectCli, parseConnectOptions } from '../src/connect-cli.js';
let home: string;
const owner = () => ({ stateDirectory: join(home, 'state'), roots: [{ directory: home, verify: { executable: process.execPath, args: ['check'] } }] });
beforeEach(async () => {
  vi.clearAllMocks(); home = await mkdtemp(join(tmpdir(), 'connect-cli-')); await writeFile(join(home, 'owner.json'), JSON.stringify(owner()));
  fake.assert.mockResolvedValue('stopped'); fake.start.mockResolvedValue({}); fake.stop.mockResolvedValue(undefined);
  fake.enroll.mockResolvedValue({ endpoint: 'https://environment.example/mcp', credentialRef: 'a'.repeat(64), state: 'ready', expiresAt: Date.now() + 100000 });
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
const login = () => ['t3-connect', 'login', '--endpoint', 'https://environment.example/mcp', '--project-id', 'chosen-project', '--home', home];
it('persists approved endpoint-bound reference and preserves owner roots without tokens', async () => {
  expect(await connectCli(login())).toBe(true);
  const saved = JSON.parse(await readFile(join(home, 'owner.json'), 'utf8'));
  expect(saved.roots).toEqual(owner().roots); expect(saved.t3).toEqual({ endpoint: 'https://environment.example/mcp', projectId: 'chosen-project', connect: { credentialRef: 'a'.repeat(64) } });
  expect(fake.start).not.toHaveBeenCalled(); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledOnce();
});
it('refuses credentials/enrollment when daemon ownership cannot be verified', async () => {
  fake.assert.mockRejectedValueOnce(new Error('live unverifiable owner'));
  await expect(connectCli(login())).rejects.toThrow('unverifiable');
  expect(fake.enroll).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(join(home, 'owner.json'), 'utf8'))).toEqual(owner());
  expect(fake.release).toHaveBeenCalledOnce();
});
it('leaves running bridge and configuration unchanged if approval fails', async () => {
  fake.assert.mockResolvedValue('running'); fake.enroll.mockRejectedValueOnce(new Error('approval timed out'));
  await expect(connectCli(login())).rejects.toThrow('timed out'); expect(fake.stop).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(home, 'owner.json'), 'utf8'))).toEqual(owner());
});
it('restores owner config and restarts previous daemon when new startup fails', async () => {
  fake.assert.mockResolvedValue('running'); fake.start.mockRejectedValueOnce(new Error('startup failed'));
  await expect(connectCli(login())).rejects.toThrow('startup failed');
  expect(JSON.parse(await readFile(join(home, 'owner.json'), 'utf8'))).toEqual(owner()); expect(fake.stop).toHaveBeenCalledOnce(); expect(fake.start).toHaveBeenCalledTimes(2);
});
it('rejects duplicate/unknown flags and unsafe argument shape', async () => {
  expect(() => parseConnectOptions(['--endpoint', 'a', '--endpoint', 'b'])).toThrow('duplicate');
  expect(() => parseConnectOptions(['--token', 'secret'])).toThrow('Unknown');
  expect(() => parseConnectOptions(['--bridge-args', '["x"]'])).toThrow('requires');
  expect(await connectCli(['unrelated'])).toBe(false);
});
