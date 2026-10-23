import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { hardenHome } from '../managed/credentials.js';
import type { ManagedPaths } from '../managed/paths.js';

// Tunnel secrets must stay in the tunnel's own credential store, never in remote.json.
// A bare token-like string is 32+ characters of the token alphabet with no path
// separators, colon, or dot-with-extension, so hostnames and config paths pass.
// UUID-shaped identifiers (e.g. `tunnel run <id>`) are names, not secrets.
const credentialArg = (value: string): boolean =>
  /(?:authtoken|--token(?:=|\s|$)|api[_-]?key|client[_-]?secret|password)/i.test(value) ||
  (/^[A-Za-z0-9+/=_-]{32,}$/.test(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));

export const remoteConfigSchema = z.object({
  origin: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.origin === value; }
    catch { return false; }
  }, 'Remote origin must be an exact HTTPS origin without credentials, path, query or fragment'),
  port: z.number().int().min(1024).max(65535),
  tunnel: z.object({
    command: z.string().max(32768).refine(value => isAbsolute(value) && !/[\0\r\n]/.test(value), 'Tunnel command must be an absolute executable path'),
    args: z.array(z.string().max(32768).refine(value => !value.includes('\0')).refine(value => !credentialArg(value), 'Tunnel credentials belong in the tunnel\'s own credential store, never in command arguments')).max(128),
  }).strict().optional(),
}).strict();
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export const remoteConfigPath = (paths: ManagedPaths): string => join(paths.home, 'remote.json');
export const remoteCredentialPaths = (paths: ManagedPaths): ManagedPaths => ({ ...paths, token: join(paths.home, 'remote-credential.bin') });

export async function readRemoteConfig(paths: ManagedPaths): Promise<RemoteConfig | undefined> {
  let info;
  try { info = await lstat(remoteConfigPath(paths)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Cannot inspect remote configuration'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('Invalid remote configuration file');
  try { return remoteConfigSchema.parse(JSON.parse(await readFile(remoteConfigPath(paths), 'utf8'))); }
  catch { throw new Error('Invalid remote configuration'); }
}

export async function saveRemoteConfig(paths: ManagedPaths, config: RemoteConfig): Promise<void> {
  const checked = remoteConfigSchema.safeParse(config);
  if (!checked.success) throw new Error('Invalid remote configuration');
  const serialized = JSON.stringify(checked.data, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 65536) throw new Error('Remote configuration exceeds size limit');
  await hardenHome(paths);
  // Do not replace a malformed or redirected file as an implicit repair.
  await readRemoteConfig(paths);
  const temporary = join(paths.home, `.remote-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, remoteConfigPath(paths));
  } finally { await unlink(temporary).catch(() => {}); }
}
