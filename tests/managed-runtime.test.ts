import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { managedPaths } from '../src/managed/paths.js';
import { ensureCredential, hardenHome, readCredential } from '../src/managed/credentials.js';
import { controlPipe, ensureControlKey } from '../src/managed/control.js';
import { healthManaged, runManagedDaemon, stopManaged } from '../src/managed/runtime.js';
import { createManagedProxy } from '../src/managed/proxy.js';
import { Redactor } from '../src/safety.js';

const execute = promisify(execFile);

describe('managed private runtime and restart-safe MCP proxy', { timeout: 60000 }, () => {
  let directory: string, paths: ReturnType<typeof managedPaths>, token: string;
  let daemon: Awaited<ReturnType<typeof runManagedDaemon>> | undefined;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bridge-managed-runtime-')); paths = managedPaths(directory);
    token = await ensureCredential(paths);
  }, 60000);
  afterAll(async () => { await daemon?.close(); await rm(directory, { recursive: true, force: true }); });

  it('persists a private reusable credential, encrypted with Windows CurrentUser DPAPI', async () => {
    expect(await readCredential(paths)).toBe(token);
    expect(await ensureCredential(paths)).toBe(token);
    if (process.platform === 'win32') {
      const stored = await readFile(paths.token, 'utf8');
      expect(stored.startsWith('grok-bridge-dpapi-v1\n')).toBe(true); expect(stored).not.toContain(token);
    }
  });

  it.runIf(process.platform === 'win32')('re-hardens the managed home idempotently to owner and SYSTEM only', async () => {
    await hardenHome(paths); await hardenHome(paths);
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $acl=Get-Acl -LiteralPath $env:BRIDGE_ACL_TARGET; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $sids=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); [pscustomobject]@{ protected=$acl.AreAccessRulesProtected; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; sid=$sid; sids=$sids } | ConvertTo-Json -Compress`;
    const { stdout } = await execute(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, BRIDGE_ACL_TARGET: paths.home }, windowsHide: true });
    const acl = JSON.parse(stdout.trim()) as { protected: boolean; owner: string; sid: string; sids: string | string[] };
    expect(acl.protected).toBe(true);
    expect(acl.owner).toBe(acl.sid);
    expect([acl.sids].flat().sort()).toEqual([acl.sid, 'S-1-5-18'].sort());
  });

  it('validates live identity and stops only the authenticated instance', async () => {
    expect((await healthManaged(paths)).running).toBe(false);
    daemon = await runManagedDaemon(paths, { repository: directory, redactor: new Redactor() });
    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
    expect(receipt).toMatchObject({ pid: process.pid, instanceId: daemon.receipt.instanceId }); expect(JSON.stringify(receipt)).not.toContain(token);
    expect(await healthManaged(paths)).toMatchObject({ running: true, receipt: daemon.receipt });
    await writeFile(paths.receipt, JSON.stringify({ ...receipt, instanceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }));
    expect((await healthManaged(paths)).running).toBe(false);
    await expect(stopManaged(paths)).rejects.toThrow('unavailable');
    await writeFile(paths.receipt, JSON.stringify(receipt));
    expect((await healthManaged(paths)).running).toBe(true);
    expect(await stopManaged(paths)).toEqual({ stopped: true });
    expect((await healthManaged(paths)).running).toBe(false);
  });

  it('rejects a second daemon without overwriting the live receipt', async () => {
    daemon = await runManagedDaemon(paths, { repository: directory, redactor: new Redactor() });
    await expect(runManagedDaemon(paths, { repository: directory, redactor: new Redactor() })).rejects.toThrow('live owner');
    expect(JSON.parse(await readFile(paths.receipt, 'utf8')).instanceId).toBe(daemon.receipt.instanceId);
    await daemon.close();
  });

  it('keeps one MCP client connected across daemon shutdown and fresh daemon startup', async () => {
    daemon = await runManagedDaemon(paths, { repository: directory, redactor: new Redactor() });
    const proxy = createManagedProxy(paths), client = new Client({ name: 'managed-proxy-test', version: '1' });
    const [front, back] = InMemoryTransport.createLinkedPair();
    await proxy.connect(back); await client.connect(front);
    try {
      expect((await client.listTools({}, { timeout: 30000 })).tools.map(tool => tool.name)).toContain('permission_evaluate');
      const before = daemon.receipt.instanceId;
      await daemon.close(); daemon = await runManagedDaemon(paths, { repository: directory, redactor: new Redactor() });
      expect(daemon.receipt.instanceId).not.toBe(before);
      expect((await client.listTools({}, { timeout: 30000 })).tools.map(tool => tool.name)).toContain('permission_evaluate');
      await expect(client.callTool({ name: 'permission_evaluate', arguments: { cwd: directory } })).rejects.toThrow('Only coding-agent');
    } finally { await client.close(); await proxy.close(); await daemon.close(); }
  });

  it('reports enrollment failures and releases the daemon lease for a corrected restart', async () => {
    await writeFile(paths.config, JSON.stringify({ roots: [] }));
    await expect(runManagedDaemon(paths)).rejects.toThrow('Enrollment required');
    expect(JSON.parse(await readFile(join(paths.home, 'startup-error.json'), 'utf8')).message).toContain('Enrollment required');
    daemon = await runManagedDaemon(paths, { repository: directory, redactor: new Redactor() });
    expect((await healthManaged(paths)).running).toBe(true); await daemon.close();
  });

  it('reclaims an acquisition guard left behind by a process that is gone', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-stale-guard-'));
    try {
      const stale = managedPaths(isolated); await ensureCredential(stale);
      const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
      const deadPid = exited.pid;
      await new Promise<void>(resolve => exited.on('exit', () => resolve()));
      if (!deadPid) throw new Error('Spawned helper did not report a pid');
      const guard = join(stale.home, 'daemon-acquisition');
      await mkdir(guard); await writeFile(join(guard, 'owner.json'), JSON.stringify({ pid: deadPid, id: randomUUID() }));
      const recovered = await runManagedDaemon(stale, { repository: isolated, redactor: new Redactor() });
      await recovered.close();
      await expect(access(guard)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  it('refuses startup while another live process holds the acquisition guard', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-live-guard-'));
    try {
      const blocked = managedPaths(isolated); await ensureCredential(blocked);
      const guard = join(blocked.home, 'daemon-acquisition');
      await mkdir(guard); await writeFile(join(guard, 'owner.json'), JSON.stringify({ pid: process.pid, id: randomUUID() }));
      await expect(runManagedDaemon(blocked, { repository: isolated, redactor: new Redactor() })).rejects.toThrow('already in progress');
      await expect(access(blocked.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  it('never transmits the bearer token over the control pipe', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-control-leak-'));
    try {
      const paths = managedPaths(isolated), token = await ensureCredential(paths);
      await ensureControlKey(paths);
      const instanceId = randomUUID();
      await writeFile(paths.receipt, JSON.stringify({ url: 'http://127.0.0.1:9/', pid: process.pid, instanceId, startedAt: new Date().toISOString() }));
      const received: string[] = [];
      const squatter = createServer(socket => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => { received.push(chunk); socket.end('{"receipt":"{}","nonce":"0","mac":"0"}\n'); });
        socket.on('error', () => {});
      });
      await new Promise<void>(resolve => squatter.listen(controlPipe(paths, instanceId), resolve));
      try {
        expect((await healthManaged(paths)).running).toBe(false);
        const request = received.join('');
        expect(request).toMatch(/"mac":"[a-f0-9]{64}"/);
        expect(request).not.toContain(token);
      } finally { await new Promise<void>(resolve => squatter.close(() => resolve())); }
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  it('reclaims a stale receipt whose daemon is gone instead of blocking setup', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-stale-receipt-'));
    try {
      const paths = managedPaths(isolated); await ensureCredential(paths);
      const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
      const deadPid = exited.pid;
      await new Promise<void>(resolve => exited.on('exit', () => resolve()));
      if (!deadPid) throw new Error('Spawned helper did not report a pid');
      await writeFile(paths.receipt, JSON.stringify({ url: 'http://127.0.0.1:9/', pid: deadPid, instanceId: randomUUID(), startedAt: new Date().toISOString() }));
      await expect(stopManaged(paths)).resolves.toEqual({ stopped: true });
      await expect(access(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  it('quarantines an invalid credential instead of wedging later setup', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-corrupt-credential-'));
    try {
      const paths = managedPaths(isolated);
      await ensureCredential(paths);
      await writeFile(paths.token, 'not-a-credential', { mode: 0o600 });
      const replacement = await ensureCredential(paths);
      expect(replacement).toMatch(/^[a-f0-9]{64}$/);
      expect(replacement).not.toBe('not-a-credential');
      expect((await readdir(isolated)).some(file => file.startsWith('credential.bin.invalid-'))).toBe(true);
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  it('quarantines a DPAPI-prefixed blob that cannot be decrypted', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'bridge-undecryptable-credential-'));
    try {
      const paths = managedPaths(isolated);
      await ensureCredential(paths);
      await writeFile(paths.token, `grok-bridge-dpapi-v1\n${Buffer.from('not a protected payload').toString('base64')}`, { mode: 0o600 });
      const replacement = await ensureCredential(paths);
      expect(replacement).toMatch(/^[a-f0-9]{64}$/);
      expect(await readCredential(paths)).toBe(replacement);
      expect((await readdir(isolated)).some(file => file.startsWith('credential.bin.invalid-'))).toBe(true);
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });
});
