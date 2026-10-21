import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { managedPaths } from './paths.js';
import { setupManaged, enrollManagedRepository } from './install.js';
import { callManaged, connectManaged, healthManaged, runManagedDaemon, startManaged, stopManaged } from './runtime.js';
import { installAutostart, removeAutostart } from './startup.js';

export function parseManagedOptions(args: string[]) {
  const options: { home?: string; repository?: string; registerClients?: boolean; autostart?: boolean; verify?: { executable: string; args: string[] } } = {};
  let executable: string | undefined, argv: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-clients') { options.registerClients = false; continue; }
    if (flag === '--no-autostart') { options.autostart = false; continue; }
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

/** Managed commands deliberately derive paths and credentials locally. */
export async function managedCli(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  if (!['setup', 'enroll', 'daemon', 'managed-daemon', 'connect', 'call', 'doctor', 'start', 'stop', 'autostart'].includes(command)) return false;
  if (command === 'setup') { console.log(JSON.stringify(await setupManaged(parseManagedOptions(rest)), null, 2)); return true; }
  if (command === 'enroll') {
    const options = parseManagedOptions(rest[0] && !rest[0].startsWith('--') ? ['--repository', rest[0], ...rest.slice(1)] : rest);
    console.log(JSON.stringify(await enrollManagedRepository(options.repository ?? process.cwd(), options.home, options.verify), null, 2)); return true;
  }
  const paths = managedPaths();
  if (command === 'call') {
    if (!rest[0] || !/^agent_[a-z_]+$/.test(rest[0]) || rest.length > 2) throw new Error('Usage: grok-agent-bridge call <agent_tool> [JSON or @arguments.json]');
    console.log(JSON.stringify(await callManaged(paths, rest[0], await toolArguments(rest[1])), null, 2)); return true;
  }
  if (command === 'autostart') {
    if (rest.length !== 1 || !['enable', 'disable'].includes(rest[0])) throw new Error('Usage: grok-agent-bridge autostart enable|disable');
    console.log(JSON.stringify(await (rest[0] === 'enable' ? installAutostart(paths) : removeAutostart(paths)), null, 2)); return true;
  }
  if (rest.length) throw new Error(`Unexpected arguments for ${command}`);
  if (command === 'daemon' || command === 'managed-daemon') await runManagedDaemon(paths);
  if (command === 'connect') await connectManaged(paths);
  if (command === 'doctor') { const health = await healthManaged(paths); console.log(JSON.stringify(health, null, 2)); }
  if (command === 'start') console.log(JSON.stringify(await startManaged(paths), null, 2));
  if (command === 'stop') console.log(JSON.stringify(await stopManaged(paths), null, 2));
  return true;
}
