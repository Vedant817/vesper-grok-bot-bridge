import { execFile, spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { childEnvironment } from '../rpc.js';
import { remoteConfigSchema, type RemoteConfig } from './config.js';

/** Starts an owner-configured native tunnel once. Survival is not a reachability check. */
export async function startRemoteTunnel(config: RemoteConfig): Promise<{ close(): Promise<void> }> {
  const checked = remoteConfigSchema.safeParse(config);
  if (!checked.success || !checked.data.tunnel) throw new Error('A valid remote tunnel configuration is required');
  const { command, args } = checked.data.tunnel;
  const info = await lstat(command).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (process.platform === 'win32' && extname(command).toLowerCase() !== '.exe')) throw new Error('Tunnel command must be an existing native executable');
  const child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore', env: childEnvironment() });
  let exited = false, spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const pid = child.pid;
    if (!pid || exited || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot ?? process.env.WINDIR;
      if (!root) throw new Error('Cannot safely stop tunnel: Windows system directory unavailable');
      await new Promise<void>((resolve, reject) => execFile(join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: 5000, env: childEnvironment() }, error => {
        if (error && !exited && child.exitCode === null && child.signalCode === null) reject(new Error('Tunnel shutdown was not acknowledged')); else resolve();
      }));
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { if (!exited) child.kill(); }
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Tunnel shutdown was not acknowledged')), 5000); })]); }
    finally { clearTimeout(timer); }
  })();
  await new Promise<void>(resolve => setTimeout(resolve, 1000));
  if (spawnFailed || exited || !child.pid) { await close().catch(() => {}); throw new Error('Remote tunnel failed during startup'); }
  return { close };
}
