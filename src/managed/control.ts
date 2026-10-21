import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, link, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedPaths } from './paths.js';

/**
 * The control channel authenticates both directions with a key that never leaves the
 * owner-only home. The bearer token used for loopback MCP is deliberately never sent
 * over a named pipe: pipe names are enumerable, and a stale receipt lets another local
 * user create a server at the same name after a crash.
 */
export function controlKeyPath(paths: ManagedPaths): string {
  return join(paths.home, 'control.key');
}

export function controlPipe(paths: ManagedPaths, instanceId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\grok-agent-bridge-${createHmac('sha256', paths.home).digest('hex').slice(0, 16)}-${instanceId}`
    : join(paths.home, `control-${instanceId}.sock`);
}

export function controlMac(key: string, kind: 'request' | 'response', ...parts: string[]): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update([kind, ...parts].join('\n')).digest('hex');
}

export function sameMac(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function readControlKey(paths: ManagedPaths): Promise<string> {
  const file = controlKeyPath(paths);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw new Error('Invalid control key file');
  const key = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid control key');
  return key;
}

/** Create the control key once; concurrent creators converge on the first hard-linked file. */
export async function ensureControlKey(paths: ManagedPaths): Promise<string> {
  try { return await readControlKey(paths); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = controlKeyPath(paths), temporary = `${file}.${randomUUID()}.tmp`;
  const key = randomBytes(32).toString('hex');
  try {
    await writeFile(temporary, key, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  return readControlKey(paths);
}
