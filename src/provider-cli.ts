import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { bridgeOwnerSchema } from './bridge/application.js';
import { probeAcp } from './bridge/acp-discovery.js';
import { resolveExecutable } from './bridge/provider.js';
import { StdioWire } from './rpc.js';
import { acquireSetupLock, assertManageableDaemon } from './managed/install.js';
import { managedPaths } from './managed/paths.js';

const strings = z.array(z.string().max(8192)).max(100);
const safeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(value => !['constructor', 'prototype', '__proto__', 't3', 'grok-bot'].includes(value));
export function parseProviderOptions(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--home', '--id', '--command', '--args', '--models', '--auth-method'].includes(flag) || Object.hasOwn(values, flag)) throw new Error('Unknown or duplicate provider option');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values[flag] = value;
  }
  if (values['--home'] && !isAbsolute(values['--home'])) throw new Error('--home must be absolute');
  return values;
}
async function atomicOwner(file: string, value: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
/** Owner-only enrollment. Never exposed as an MCP executable-configuration tool. */
export async function providerCli(args: string[]): Promise<boolean> {
  if (args[0] !== 'provider') return false;
  const action = args[1];
  if (!['add', 'list'].includes(action)) throw new Error('Usage: provider add --id <id> --command <absolute native executable> --args <JSON array> [--models <JSON array>] [--auth-method <advertised id>] [--home <absolute folder>] | provider list [--home <absolute folder>]');
  const options = parseProviderOptions(args.slice(2)), paths = managedPaths(options['--home']);
  if (action === 'list') {
    if (Object.keys(options).some(key => key !== '--home')) throw new Error('provider list accepts only --home');
    const owner = bridgeOwnerSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
    console.log(JSON.stringify(Object.entries(owner.providers).map(([id, provider]) => ({ id, protocol: provider.protocol ?? 'native-default', models: provider.models ?? [], authentication: 'not_checked' })), null, 2));
    return true;
  }
  const id = safeId.parse(options['--id']), command = options['--command'];
  if (!command || !isAbsolute(command) || ['.cmd', '.bat', '.ps1', '.js', '.mjs', '.cjs'].includes(extname(command).toLowerCase())) throw new Error('--command must be an absolute native executable; invoke JavaScript adapters through an explicit Node executable and --args');
  if (!options['--args']) throw new Error('--args JSON array is required, including [] when empty');
  const argv = strings.parse(JSON.parse(options['--args']));
  const models = options['--models'] === undefined ? undefined : strings.parse(JSON.parse(options['--models']));
  const authMethodId = options['--auth-method'] === undefined ? undefined : z.string().min(1).max(200).parse(options['--auth-method']);
  const launch = await resolveExecutable(command);
  if (!launch || launch.args.length) throw new Error('Native executable is unavailable');
  const provider = { executable: launch.executable, args: argv, protocol: 'acp' as const, ...(models ? { models } : {}), ...(authMethodId ? { authMethodId } : {}) };
  const lock = await acquireSetupLock(join(paths.home, 'setup.lock'));
  try {
    const previous = await readFile(paths.config, 'utf8');
    const raw: unknown = JSON.parse(previous), owner = bridgeOwnerSchema.parse(raw);
    if (await assertManageableDaemon(paths) === 'running') throw new Error('Stop the bridge before changing provider configuration; existing sessions must be reconciled first');
    const existing = owner.providers[id];
    if (existing) {
      if (!isDeepStrictEqual(existing, provider)) throw new Error('Provider id is already enrolled with different configuration');
      console.log(JSON.stringify({ id, enrolled: true, unchanged: true, daemonRestarted: false })); return true;
    }
    // Validate the entire prospective owner before running a child process. Keep the
    // raw fields on publication so schema defaults do not rewrite unrelated state.
    const next = { ...(raw as Record<string, unknown>), providers: { ...owner.providers, [id]: provider } };
    bridgeOwnerSchema.parse(next);
    let metadata;
    try { metadata = await probeAcp(() => new StdioWire(launch.executable, argv, paths.home)); }
    catch { throw new Error('ACP initialize-only probe failed; configuration was preserved'); }
    if (authMethodId && !metadata.authMethods.some(method => method.id === authMethodId)) throw new Error('Requested authentication method was not advertised by the ACP agent');
    // Never stop or restart a daemon behind a session controller. Recheck after
    // the bounded handshake; startup itself remains an explicit maintenance step.
    if (await assertManageableDaemon(paths) !== 'stopped') throw new Error('Daemon state changed during enrollment; stop the bridge before retrying');
    try { await atomicOwner(paths.config, JSON.stringify(next, null, 2) + '\n'); }
    catch {
      await atomicOwner(paths.config, previous);
      throw new Error('Provider publication failed; previous configuration restored');
    }
    console.log(JSON.stringify({ id, enrolled: true, protocol: 'acp', authentication: 'not_checked', daemonRestarted: false })); return true;
  } finally { await lock.release(); }
}
