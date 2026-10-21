import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { managedPaths } from './paths.js';
import { setupManaged, enrollManagedRepository, acquireSetupLock } from './install.js';
import { callManaged, connectManaged, healthManaged, runManagedDaemon, startManaged, stopManaged } from './runtime.js';
import { installAutostart, removeAutostart, autostartStatus } from './startup.js';
import { hardenHome, readCredential } from './credentials.js';

export function parseManagedOptions(args: string[]) {
  const options: { home?: string; repository?: string; registerClients?: boolean; autostart?: boolean; forceSetupLock?: boolean; verify?: { executable: string; args: string[] } } = {};
  let executable: string | undefined, argv: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-clients') { options.registerClients = false; continue; }
    if (flag === '--no-autostart') { options.autostart = false; continue; }
    if (flag === '--force-setup-lock') { options.forceSetupLock = true; continue; }
    if (!['--home', '--repository', '--verify-executable', '--verify-args'].includes(flag)) throw new Error(`Unknown setup option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--home') options.home = resolve(value);
    if (flag === '--repository') options.repository = resolve(value);
    if (flag === '--verify-executable') executable = value;
    if (flag === '--verify-args') argv = z.array(z.string()).max(100).parse(JSON.parse(value));
  }
  if (argv && !executable) throw new Error('--verify-args requires --verify-executable');
  if (executable) options.verify = { executable, args: argv ?? [] };
  return options;
}

/** Every managed command accepts --home so a custom installation is never silently missed. */
function takeHome(args: string[]): { home?: string; rest: string[] } {
  const rest: string[] = [];
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--home') { rest.push(args[i]); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --home');
    home = resolve(value);
  }
  return { home, rest };
}

async function toolArguments(source?: string): Promise<Record<string, unknown>> {
  let text = source ?? '{}';
  if (source?.startsWith('@')) {
    const file = await readFile(resolve(source.slice(1)));
    if (file.byteLength > 65536) throw new Error('Tool arguments exceed 64KB');
    text = file.toString('utf8');
  }
  if (text.length > 65536) throw new Error('Tool arguments exceed 64KB');
  return z.record(z.unknown()).parse(JSON.parse(text));
}

async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function readJsonSafe(file: string): Promise<{ value?: any; invalid?: boolean }> {
  try {
    const value = await readJson(file);
    // A JSON `null` is not a missing file and cannot be a valid owner/installation record.
    return value === null ? { invalid: true } : { value };
  } catch { return { invalid: true }; }
}

async function doctorReport(paths: ReturnType<typeof managedPaths>) {
  const health = await healthManaged(paths);
  const installationState = await readJsonSafe(paths.installation);
  const ownerState = await readJsonSafe(paths.config);
  const startupState = await readJsonSafe(join(paths.home, 'startup-error.json'));
  const credential = await readCredential(paths).then(() => 'ok', () => 'unavailable');
  let installation: unknown = 'missing';
  if (installationState.invalid) installation = 'invalid';
  else if (installationState.value) {
    const entrypoint = installationState.value.entrypoint, node = installationState.value.node;
    const entrypointPresent = typeof entrypoint === 'string' && await stat(entrypoint).then(info => info.isFile(), () => false);
    const nodePresent = typeof node === 'string' && await stat(node).then(info => info.isFile(), () => false);
    installation = entrypointPresent && nodePresent
      ? { version: installationState.value.version, entrypoint, node, installedAt: installationState.value.installedAt, pty: installationState.value.pty ?? 'unknown' }
      : 'invalid';
  }
  const launcher = await stat(paths.launcher).then(info => info.isFile() ? 'present' : 'invalid', () => 'missing');
  const enrolledRoots = ownerState.invalid ? 'invalid' : Array.isArray(ownerState.value?.roots) ? ownerState.value.roots.length : 0;
  const configurable = !ownerState.invalid && typeof enrolledRoots === 'number' && enrolledRoots > 0;
  const startupError = startupState.invalid ? 'invalid' : startupState.value ?? null;
  // A live daemon is not enough: clients and the CLI need the published release,
  // launcher, credential, and restartable owner configuration after this process exits.
  const healthy = health.running && typeof installation === 'object' && launcher === 'present' && credential === 'ok' && configurable;
  return { healthy, health, installation, enrolledRoots, credential, launcher, autostart: await autostartStatus(paths), startupError };
}

/** Managed commands deliberately derive paths and credentials locally. */
export async function managedCli(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  if (!['setup', 'enroll', 'daemon', 'managed-daemon', 'connect', 'call', 'doctor', 'start', 'stop', 'autostart'].includes(command)) return false;
  if (command === 'setup') { console.log(JSON.stringify(await setupManaged(parseManagedOptions(rest)), null, 2)); return true; }
  if (command === 'enroll') {
    const options = parseManagedOptions(rest[0] && !rest[0].startsWith('--') ? ['--repository', rest[0], ...rest.slice(1)] : rest);
    // setup holds this lock while enrolling; standalone enroll needs the same exclusion
    // so neither can rewrite owner.json or restart the daemon underneath the other.
    const paths = managedPaths(options.home);
    await hardenHome(paths);
    const lock = await acquireSetupLock(join(paths.home, 'setup.lock'), options.forceSetupLock === true);
    try { console.log(JSON.stringify(await enrollManagedRepository(options.repository ?? process.cwd(), options.home, options.verify), null, 2)); }
    finally { await lock.release(); }
    return true;
  }
  const { home, rest: remaining } = takeHome(rest);
  const paths = managedPaths(home);
  if (command === 'call') {
    if (!remaining[0] || !/^agent_[a-z_]+$/.test(remaining[0]) || remaining.length > 2) throw new Error('Usage: grok-agent-bridge call <agent_tool> [JSON or @arguments.json]');
    console.log(JSON.stringify(await callManaged(paths, remaining[0], await toolArguments(remaining[1])), null, 2)); return true;
  }
  if (command === 'autostart') {
    if (remaining.length !== 1 || !['enable', 'disable'].includes(remaining[0])) throw new Error('Usage: grok-agent-bridge autostart enable|disable');
    console.log(JSON.stringify(await (remaining[0] === 'enable' ? installAutostart(paths) : removeAutostart(paths)), null, 2)); return true;
  }
  if (remaining.length) throw new Error(`Unexpected arguments for ${command}`);
  if (command === 'daemon' || command === 'managed-daemon') await runManagedDaemon(paths);
  if (command === 'connect') await connectManaged(paths);
  if (command === 'doctor') {
    const report = await doctorReport(paths);
    console.log(JSON.stringify(report, null, 2));
    if (!report.healthy) process.exitCode = 1;
  }
  if (command === 'start') console.log(JSON.stringify(await startManaged(paths), null, 2));
  if (command === 'stop') console.log(JSON.stringify(await stopManaged(paths), null, 2));
  return true;
}
