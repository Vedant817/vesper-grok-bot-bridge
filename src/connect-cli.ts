import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { bridgeOwnerSchema } from './bridge/application.js';
import { connectStatus, enrollConnect, FileConnectCredentialStore } from './connect/index.js';
import { managedPaths } from './managed/paths.js';
import { acquireSetupLock, assertManageableDaemon } from './managed/install.js';
import { startManaged, stopManaged } from './managed/runtime.js';

export function parseConnectOptions(args: string[]) {
  const result: { home?: string; endpoint?: string; projectId?: string; bridge?: { command: string; args?: string[] } } = {};
  let command: string | undefined, argv: string[] | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--home', '--endpoint', '--project-id', '--bridge-command', '--bridge-args'].includes(flag) || seen.has(flag)) throw new Error('Unknown or duplicate T3 Connect option');
    seen.add(flag); const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--home') result.home = resolve(value);
    if (flag === '--endpoint') result.endpoint = value;
    if (flag === '--project-id') result.projectId = value;
    if (flag === '--bridge-command') command = value;
    if (flag === '--bridge-args') argv = z.array(z.string()).max(100).parse(JSON.parse(value));
  }
  if (argv && !command) throw new Error('--bridge-args requires --bridge-command');
  if (command) result.bridge = { command, args: argv ?? [] };
  return result;
}
async function openBrowser(url: URL) {
  if (url.protocol !== 'https:') throw new Error('Approval browser URL must use HTTPS');
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Unable to open approval browser')); }, 10000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Unable to open approval browser')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Unable to open approval browser')); });
  });
}
async function atomicOwner(file: string, text: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}
/** One-time native OAuth enrollment; no tokens or arbitrary native credentials enter chat. */
export async function connectCli(args: string[]): Promise<boolean> {
  if (args[0] !== 't3-connect') return false;
  const action = args[1];
  if (!['login', 'status'].includes(action)) throw new Error('Usage: t3-connect login --endpoint <HTTPS /mcp URL> --project-id <id> | t3-connect status [--home <folder>]');
  const options = parseConnectOptions(args.slice(2)), paths = managedPaths(options.home);
  const store = new FileConnectCredentialStore(join(paths.home, 'connect'));
  if (action === 'status') {
    const owner = bridgeOwnerSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
    const endpoint = options.endpoint ?? owner.t3?.endpoint;
    if (!endpoint) throw new Error('No T3 Connect endpoint is enrolled');
    console.log(JSON.stringify(await connectStatus({ endpoint, credentialRef: owner.t3?.connect?.credentialRef, store }), null, 2)); return true;
  }
  if (!options.endpoint || !options.projectId) throw new Error('T3 Connect login requires --endpoint and --project-id from the chosen T3 environment');
  const lock = await acquireSetupLock(join(paths.home, 'setup.lock'));
  try {
    const previous = await readFile(paths.config, 'utf8');
    const owner = bridgeOwnerSchema.parse(JSON.parse(previous));
    const running = await assertManageableDaemon(paths) === 'running';
    console.error('Complete the T3 MCP approval in your browser. This approval is separate from t3 connect login.');
    const status = await enrollConnect({ endpoint: options.endpoint, store, openBrowser });
    const next = bridgeOwnerSchema.parse({ ...owner, t3: { projectId: options.projectId, endpoint: status.endpoint, connect: { credentialRef: status.credentialRef, ...(options.bridge ? { bridge: options.bridge } : {}) } } });
    // Stop only after enrollment succeeds. Roll back configuration if publication/restart fails.
    if (running) await stopManaged(paths);
    try { await atomicOwner(paths.config, JSON.stringify(next, null, 2)); if (running) await startManaged(paths); }
    catch (error) { await atomicOwner(paths.config, previous); if (running) await startManaged(paths).catch(() => {}); throw error; }
    console.log(JSON.stringify(status, null, 2)); return true;
  } finally { await lock.release(); }
}
