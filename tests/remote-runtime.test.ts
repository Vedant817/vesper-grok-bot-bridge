import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { managedPaths } from '../src/managed/paths.js';
import { ensureCredential } from '../src/managed/credentials.js';
import { runManagedDaemon, healthManaged, stopManaged, daemonStatus } from '../src/managed/runtime.js';
import { saveRemoteConfig, remoteCredentialPaths } from '../src/remote/config.js';
import { parseRemoteOptions, remoteCli } from '../src/remote-cli.js';
import { Redactor } from '../src/safety.js';

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
describe('standalone managed remote integration', { timeout: 60000 }, () => {
  it('acknowledges stop during tunnel startup only after closing remote exposure and retains no signal handlers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-start-stop-')), paths = managedPaths(home), port = await freePort();
    const fixture = join(home, 'tunnel.cjs'), marker = join(home, 'started');
    const signals = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') };
    let daemon: Awaited<ReturnType<typeof runManagedDaemon>> | undefined;
    let startup: ReturnType<typeof runManagedDaemon> | undefined;
    try {
      await ensureCredential(paths); const token = await ensureCredential(remoteCredentialPaths(paths));
      await writeFile(fixture, "require('node:fs').writeFileSync(process.argv[2],'started');setInterval(()=>{},1000);");
      await saveRemoteConfig(paths, { origin: 'https://remote.example.invalid', port, tunnel: { command: process.execPath, args: [fixture, marker] } });
      startup = runManagedDaemon(paths, { repository: home, redactor: new Redactor() });
      let started = false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        started = await readFile(marker, 'utf8').then(() => true, () => false);
        if (started) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(started).toBe(true);
      expect(await stopManaged(paths)).toEqual({ stopped: true });
      daemon = await startup;
      await daemon.close();
      expect(await daemonStatus(paths)).toEqual({ state: 'stopped' });
      await expect(fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow();
      expect(process.listenerCount('SIGINT')).toBe(signals.interrupt);
      expect(process.listenerCount('SIGTERM')).toBe(signals.terminate);
    } finally {
      daemon ??= await startup?.catch(() => undefined);
      await daemon?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it('rejects ambiguous options', () => {
    expect(() => parseRemoteOptions(['--port', '42'])).toThrow();
    expect(() => parseRemoteOptions(['--origin', 'https://a', '--origin', 'https://b'])).toThrow();
    expect(() => parseRemoteOptions(['--tunnel-args', '[]'])).toThrow('requires');
  });
  it('keeps local service alive when remote configuration is malformed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-runtime-fail-')), paths = managedPaths(home);
    let daemon: Awaited<ReturnType<typeof runManagedDaemon>> | undefined;
    try {
      await ensureCredential(paths); await writeFile(join(home, 'remote.json'), '{private-invalid');
      daemon = await runManagedDaemon(paths, { repository: home, redactor: new Redactor() });
      expect((await healthManaged(paths)).running).toBe(true);
      expect(JSON.parse(await readFile(join(home, 'remote-runtime.json'), 'utf8'))).toEqual({ state: 'failed', publicReachability: 'not_checked' });
    } finally { await daemon?.close(); await rm(home, { recursive: true, force: true }); }
  });
  it('serves SDK discovery through the authenticated gateway and retains enrollment after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-runtime-sdk-')), paths = managedPaths(home), port = await freePort();
    let daemon: Awaited<ReturnType<typeof runManagedDaemon>> | undefined;
    const client = new Client({ name: 'standalone-test', version: '1' });
    try {
      const localToken = await ensureCredential(paths), remoteToken = await ensureCredential(remoteCredentialPaths(paths));
      expect(remoteToken).not.toBe(localToken);
      await saveRemoteConfig(paths, { origin: 'https://remote.example.invalid', port });
      daemon = await runManagedDaemon(paths, { repository: home, redactor: new Redactor() });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${remoteToken}` } } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('permission_evaluate');
      expect((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: `Bearer ${localToken}` } })).status).toBe(401);
      await expect(remoteCli(['remote', 'disable', '--home', home])).rejects.toThrow('Stop the managed bridge');
      await client.close(); await daemon.close();
      daemon = await runManagedDaemon(paths, { repository: home, redactor: new Redactor() });
      expect(JSON.parse(await readFile(join(home, 'remote-runtime.json'), 'utf8'))).toMatchObject({ state: 'listening', endpoint: 'https://remote.example.invalid/mcp' });
      await daemon.close(); daemon = undefined;
      await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
    } finally { await client.close(); await daemon?.close(); await rm(home, { recursive: true, force: true }); }
  });
});
