import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ failRename: false, harden: vi.fn() }));
vi.mock('../src/managed/credentials.js', () => ({ hardenHome: state.harden }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (state.failRename) throw new Error('publication failed'); return actual.rename(...args);
  } };
});
import { managedPaths } from '../src/managed/paths.js';
import { readRemoteConfig, remoteCredentialPaths, saveRemoteConfig } from '../src/remote/config.js';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'remote-config-')); state.failRename = false; state.harden.mockReset().mockResolvedValue(undefined); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const config = () => ({ origin: 'https://example.ngrok.app', port: 18771, tunnel: { command: process.execPath, args: ['http', '--url=https://example.ngrok.app', '18771'] } });
it('missing configuration is disabled; writes are hardened and survive reread with a separate credential path', async () => {
  const paths = managedPaths(home);
  expect(await readRemoteConfig(paths)).toBeUndefined();
  await saveRemoteConfig(paths, config());
  expect(state.harden).toHaveBeenCalledWith(paths);
  expect(await readRemoteConfig(paths)).toEqual(config());
  expect(remoteCredentialPaths(paths).token).toBe(join(home, 'remote-credential.bin'));
  expect(paths.token).toBe(join(home, 'credential.bin'));
  expect(await readdir(home)).toEqual(['remote.json']);
});
it.each(['http://host.test', 'https://host.test/', 'https://host.test/mcp', 'https://host.test?x=1', 'https://host.test#x', 'https://user:secret@host.test', 'https://HOST.test', 'invalid'])('refuses nonexact or insecure origin %s before writing', async origin => {
  await expect(saveRemoteConfig(managedPaths(home), { ...config(), origin })).rejects.toThrow('Invalid remote configuration');
  expect(await readdir(home)).toEqual([]); expect(state.harden).not.toHaveBeenCalled();
});
it.each([0, 1023, 65536, 12.5, NaN])('refuses invalid port %s', async port => {
  await expect(saveRemoteConfig(managedPaths(home), { ...config(), port })).rejects.toThrow();
});
it('rejects unknown fields, relative executable paths and NUL arguments', async () => {
  for (const value of [{ ...config(), secret: 'token' }, { ...config(), tunnel: { command: 'ngrok', args: [] } }, { ...config(), tunnel: { command: process.execPath, args: ['bad\0arg'] } }]) {
    await expect(saveRemoteConfig(managedPaths(home), value as ReturnType<typeof config>)).rejects.toThrow();
  }
  expect(await readdir(home)).toEqual([]);
});
it('refuses configurations larger than its persisted read limit before hardening or publication', async () => {
  await expect(saveRemoteConfig(managedPaths(home), { ...config(), tunnel: { command: process.execPath, args: Array(8).fill('x'.repeat(16384)) } })).rejects.toThrow('size limit');
  expect(state.harden).not.toHaveBeenCalled(); expect(await readdir(home)).toEqual([]);
});
it('fails closed and preserves malformed existing configuration', async () => {
  await writeFile(join(home, 'remote.json'), '{truncated', { mode: 0o600 });
  await expect(readRemoteConfig(managedPaths(home))).rejects.toThrow('Invalid remote configuration');
  await expect(saveRemoteConfig(managedPaths(home), config())).rejects.toThrow('Invalid remote configuration');
  expect(await readFile(join(home, 'remote.json'), 'utf8')).toBe('{truncated');
});
it('publication failure preserves exact old bytes and removes only its temporary file', async () => {
  const paths = managedPaths(home); await saveRemoteConfig(paths, config());
  const before = await readFile(join(home, 'remote.json'), 'utf8');
  state.failRename = true;
  await expect(saveRemoteConfig(paths, { ...config(), port: 18772 })).rejects.toThrow('publication failed');
  expect(await readFile(join(home, 'remote.json'), 'utf8')).toBe(before);
  expect(await readdir(home)).toEqual(['remote.json']);
});
