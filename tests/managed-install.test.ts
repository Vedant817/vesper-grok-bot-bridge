import { describe, expect, it, afterEach } from 'vitest';
import { access, mkdtemp, writeFile, readFile, rm, mkdir, utimes } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { managedPaths } from '../src/managed/paths.js';
import { acquireSetupLock, cliShim, enrollManagedRepository, inferVerifier, launcherSource } from '../src/managed/install.js';
import { git } from '../src/worktree.js';
import { parseManagedOptions } from '../src/managed/cli.js';
import { daemonVbs, encodeVbs, startupScript, startupTaskName, autostartStatus, removeAutostart } from '../src/managed/startup.js';
import { mergeOpenCodeConfig } from '../src/managed/clients.js';
import { ensureCredential, hardenHome, readCredential } from '../src/managed/credentials.js';

const dirs: string[] = [];
async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'bridge-install-test-')); dirs.push(directory); return directory; }
afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe('managed installation contracts', () => {
  it('preserves OpenCode JSONC comments and unrelated provider settings', () => {
    const paths = managedPaths(join(tmpdir(), 'bridge user'));
    const initial = '{\n // user provider\n "model":"user/model", "mcp":{"existing":{"type":"remote","url":"https://example.test"}},\n}';
    const merged = mergeOpenCodeConfig(initial, paths);
    expect(merged.changed).toBe(true); expect(merged.text).toContain('// user provider');
    const config = parse(merged.text);
    expect(config.model).toBe('user/model'); expect(config.mcp.existing.url).toBe('https://example.test');
    expect(config.mcp['coding-agent-bridge'].command).toEqual([process.execPath, paths.launcher, 'connect']);
    expect(mergeOpenCodeConfig(merged.text, paths).changed).toBe(false);
    expect(merged.text).not.toMatch(/Bearer|credential|token/i);
  });
  it('rejects malformed config and preserves conflicting MCP registration', () => {
    const paths = managedPaths(join(tmpdir(), 'bridge'));
    expect(() => mergeOpenCodeConfig('{"broken":', paths)).toThrow('valid JSONC');
    expect(() => mergeOpenCodeConfig('{"mcp":{"coding-agent-bridge":{"type":"remote","url":"https://other"}}}', paths)).toThrow('conflicts');
  });
  it('requires a real owner verifier rather than manufacturing success', async () => {
    const directory = await temporary();
    expect(await inferVerifier(directory)).toBeUndefined();
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await inferVerifier(directory)).toBeUndefined();
    const explicit = { executable: process.execPath, args: ['verify.mjs'] };
    expect(await inferVerifier(directory, explicit)).toEqual(explicit);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit && vitest run', test: 'vitest run' } }));
    const inferred = await inferVerifier(directory);
    expect(inferred?.args.slice(-2)).toEqual(['run', 'check']);
    expect(inferred?.executable).toBe(process.execPath);
  });
  it('generates a private-home launcher using a release receipt, independent of checkout', () => {
    const home = join(tmpdir(), "owner's bridge");
    const source = launcherSource(home);
    expect(source).toContain(JSON.stringify(home)); expect(source).toContain('installation.json');
    expect(source).toContain('i.entrypoint'); expect(source).toContain('GROK_AGENT_BRIDGE_HOME');
    expect(source).not.toContain('MCP_SERVER_TOKEN');
  });
  it('scopes logon startup identity to installation and requests restart without elevation', () => {
    const a = managedPaths(join(tmpdir(), "user's bridge")), b = managedPaths(join(tmpdir(), 'other-bridge'));
    expect(startupTaskName(a)).not.toEqual(startupTaskName(b));
    const script = startupScript(a);
    expect(script).toContain('-RunLevel Limited'); expect(script).toContain('-LogonType Interactive');
    expect(script).toContain('-Hidden'); expect(script).toContain('-RestartCount 3');
    expect(script).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(script).toContain("user''s bridge"); expect(script).not.toContain('credential.bin');
    expect(script).toContain('wscript.exe'); expect(script).toContain('daemon.vbs');
  });
  it('runs the daemon through a hidden VBS trampoline rather than a visible console', () => {
    const paths = managedPaths(join(tmpdir(), "user's bridge"));
    const vbs = daemonVbs(paths, 'C:\\Node\\node.exe');
    expect(vbs).toContain('CreateObject("WScript.Shell").Run');
    expect(vbs).toContain(', 0, True');
    expect(vbs).toContain('daemon');
    expect(vbs).not.toContain('credential');
  });
  it('keeps the Windows CLI shim ASCII-only and locates the launcher at runtime', () => {
    const shim = cliShim();
    expect(shim.startsWith('@echo off')).toBe(true);
    expect(shim).toContain('setlocal DisableDelayedExpansion');
    expect(shim).toContain('%~dp0');
    expect(shim).toContain('launcher.cjs');
    expect(/^[\x00-\x7F]+$/.test(shim)).toBe(true);
  });
  it('rejects Windows home paths that PATH or logon expansion would corrupt', () => {
    if (process.platform !== 'win32') return;
    expect(() => managedPaths(join(tmpdir(), 'semi;colon'))).toThrow('cannot contain');
    expect(() => managedPaths(join(tmpdir(), 'percent%var'))).toThrow('cannot contain');
  });
  it('parses the explicit setup-lock recovery flag', () => {
    expect(parseManagedOptions(['--force-setup-lock']).forceSetupLock).toBe(true);
    expect(parseManagedOptions([]).forceSetupLock).toBeUndefined();
  });
  it('never steals a live setup lock by age, but an explicit force recovers a reused PID', async () => {
    const directory = await temporary(), file = join(directory, 'setup.lock');
    await writeFile(file, JSON.stringify({ pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() }));
    const old = new Date(Date.now() - 16 * 60 * 1000);
    await utimes(file, old, old);
    await expect(acquireSetupLock(file)).rejects.toThrow('--force-setup-lock');
    const lock = await acquireSetupLock(file, true);
    await lock.release();
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports disabled and removes nothing when no autostart entry exists', async () => {
    if (process.platform !== 'win32') return;
    const paths = managedPaths(join(await temporary(), 'autostart-empty'));
    await expect(autostartStatus(paths)).resolves.toBe('disabled');
    await expect(removeAutostart(paths)).resolves.toEqual({ removed: false });
  }, 30000);
  it('encodes logon scripts as UTF-16LE so Unicode homes survive WSH decoding', () => {
    const paths = managedPaths(join(tmpdir(), 'José 工具'));
    const encoded = encodeVbs(daemonVbs(paths, 'C:\\Node\\node.exe'));
    expect([encoded[0], encoded[1]]).toEqual([0xff, 0xfe]);
    expect(encoded.subarray(2).toString('utf16le')).toContain(paths.home);
  });
  it('keeps non-ASCII home paths intact through the credential helper', async () => {
    const directory = await temporary(), paths = managedPaths(join(directory, 'José 工具'));
    const token = await ensureCredential(paths);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readCredential(paths)).toBe(token);
  });
  it('refuses to strip ACLs from an unrelated non-empty directory', async () => {
    const directory = await temporary();
    await writeFile(join(directory, 'notes.txt'), 'keep');
    await expect(hardenHome(managedPaths(directory))).rejects.toThrow('not a managed bridge home');
    expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('keep');
  });
  it('reclaims an interrupted setup lock and never deletes a live owner', async () => {
    const directory = await temporary(), file = join(directory, 'setup.lock');
    const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const deadPid = exited.pid;
    await new Promise<void>(resolve => exited.on('exit', () => resolve()));
    if (!deadPid) throw new Error('Spawned helper did not report a pid');
    await writeFile(file, JSON.stringify({ pid: deadPid, id: randomUUID(), startedAt: new Date().toISOString() }));
    const lock = await acquireSetupLock(file);
    await lock.release();
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(file, JSON.stringify({ pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() }));
    await expect(acquireSetupLock(file)).rejects.toThrow('Another setup is running');
  });
  it('does not release a setup lock that was replaced by another owner', async () => {
    const directory = await temporary(), file = join(directory, 'setup.lock');
    const lock = await acquireSetupLock(file);
    await writeFile(file, JSON.stringify({ pid: process.pid, id: randomUUID() }));
    await lock.release();
    await expect(access(file)).resolves.toBeUndefined();
  });
  it.each([
    { raw: '{truncated', receipt: true }, { raw: '{"pid":"unknown"}', receipt: true },
    { raw: '{truncated', receipt: false }, { raw: '{"pid":"unknown"}', receipt: false },
    { raw: JSON.stringify({ pid: process.pid, id: randomUUID() }), receipt: false },
  ])('preserves enrollment with an unverifiable owner and receipt=$receipt: $raw', async ({ raw, receipt }) => {
    const home = await temporary(), paths = managedPaths(home);
    await hardenHome(paths);
    const repository = await temporary(); await git(repository, ['init']);
    const previous = JSON.stringify({ stateDirectory: join(home, 'state'), roots: [] });
    await writeFile(paths.config, previous);
    if (receipt) await writeFile(paths.receipt, '{unreadable-receipt');
    const owner = join(home, 'daemon-owner.json'); await writeFile(owner, raw);
    const old = new Date(Date.now() - 120000); await utimes(owner, old, old);
    await expect(enrollManagedRepository(repository, home, { executable: process.execPath, args: ['verify.mjs'] })).rejects.toThrow(/owner/);
    expect(await readFile(paths.config, 'utf8')).toBe(previous);
    expect(await readFile(owner, 'utf8')).toBe(raw);
  }, 20000);
  it.runIf(process.platform === 'win32')('propagates a failed daemon exit through the real Windows logon trampoline', async () => {
    const home = await temporary(), paths = managedPaths(home), script = join(home, 'daemon.vbs');
    await writeFile(paths.launcher, 'process.exit(23);');
    await writeFile(script, encodeVbs(daemonVbs(paths)));
    await expect(promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe'), ['//B', '//NoLogo', script], { windowsHide: true, timeout: 15000 })).rejects.toMatchObject({ code: 23 });
  }, 20000);
});
