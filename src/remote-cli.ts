import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { managedPaths } from './managed/paths.js';
import { acquireSetupLock, assertManageableDaemon } from './managed/install.js';
import { ensureCredential, readCredential } from './managed/credentials.js';
import { daemonStatus } from './managed/runtime.js';
import { powershellEnvironment, powershellPath } from './managed/powershell.js';
import { readRemoteConfig, saveRemoteConfig, remoteCredentialPaths, remoteConfigSchema } from './remote/config.js';

export function parseRemoteOptions(args: string[]) {
  const options: { home?: string; origin?: string; port?: number; command?: string; args?: string[] } = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--home', '--origin', '--port', '--tunnel-command', '--tunnel-args'].includes(flag) || seen.has(flag)) throw new Error('Unknown or duplicate remote option');
    seen.add(flag); const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing remote option value');
    if (flag === '--home') options.home = resolve(value);
    if (flag === '--origin') options.origin = value;
    if (flag === '--port') options.port = z.number().int().min(1024).max(65535).parse(Number(value));
    if (flag === '--tunnel-command') options.command = value;
    if (flag === '--tunnel-args') options.args = z.array(z.string().max(4096)).max(100).parse(JSON.parse(value));
  }
  if (options.args && !options.command) throw new Error('--tunnel-args requires --tunnel-command');
  return options;
}

/** This credential goes only to the OS clipboard, never stdout, argv, logs or chat. */
async function copyCredential(token: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Clipboard enrollment currently requires Windows; use a private OS credential channel on other systems');
  const script = "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd(); Set-Clipboard -Value $v; [Console]::Out.WriteLine('copied'); Start-Sleep -Seconds 60; if((Get-Clipboard -Raw).TrimEnd() -ceq $v){Set-Clipboard -Value ''}";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: powershellEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false, output = '';
    const timer = setTimeout(() => { child.kill(); finish(new Error('Private clipboard operation timed out')); }, 10000);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else { child.stdout.destroy(); child.unref(); resolve(); } };
    child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('copied')) finish(); });
    child.on('error', () => finish(new Error('Private clipboard operation failed')));
    child.on('close', () => { if (!settled) finish(new Error('Private clipboard operation failed')); });
    child.stdin.on('error', () => {}); child.stdin.end(token);
  });
}

export async function remoteCli(args: string[]): Promise<boolean> {
  if (args[0] !== 'remote') return false;
  const action = args[1];
  if (!['enable', 'disable', 'status', 'copy-token'].includes(action)) throw new Error('Usage: remote enable --origin <HTTPS origin> --port <port> [--tunnel-command <absolute executable> --tunnel-args <JSON array>] | remote status|disable|copy-token [--home <folder>]');
  const options = parseRemoteOptions(args.slice(2)), paths = managedPaths(options.home);
  if (action === 'status') {
    const config = await readRemoteConfig(paths);
    const credential = config ? await readCredential(remoteCredentialPaths(paths)).then(() => 'ready', () => 'unavailable') : 'not_created';
    const daemon = await daemonStatus(paths);
    const runtime = await readFile(join(paths.home, 'remote-runtime.json'), 'utf8').then(text => z.object({ state: z.enum(['disabled', 'listening', 'failed']), endpoint: z.string().url().optional(), tunnel: z.enum(['started', 'external']).optional(), publicReachability: z.literal('not_checked') }).strict().parse(JSON.parse(text)), () => undefined);
    console.log(JSON.stringify({ enabled: !!config, endpoint: config ? `${config.origin}/mcp` : undefined, credential, daemon: daemon.state, runtime: daemon.state === 'running' ? runtime : undefined, publicReachability: 'not_checked' }, null, 2)); return true;
  }
  if (action === 'copy-token') {
    if (!await readRemoteConfig(paths)) throw new Error('Remote gateway is not enrolled');
    await copyCredential(await readCredential(remoteCredentialPaths(paths)));
    console.log('Remote credential copied privately. Paste only into the connector Authorization secret field as Bearer <paste>. The clipboard clears after 60 seconds if unchanged.'); return true;
  }
  const lock = await acquireSetupLock(join(paths.home, 'setup.lock'));
  try {
    if (await assertManageableDaemon(paths) !== 'stopped') throw new Error('Stop the managed bridge before changing remote exposure; active sessions must be reconciled first');
    if (action === 'disable') { await unlink(join(paths.home, 'remote.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); console.log('Remote gateway disabled. Its credential is retained privately.'); return true; }
    if (!options.origin || !options.port) throw new Error('Remote enable requires --origin and --port');
    // Validate and privately publish configuration only after an enrolled owner exists.
    JSON.parse(await readFile(paths.config, 'utf8'));
    const next = remoteConfigSchema.safeParse({ origin: options.origin, port: options.port, ...(options.command ? { tunnel: { command: options.command, args: options.args ?? [] } } : {}) });
    if (!next.success) throw new Error('Invalid remote configuration');
    await ensureCredential(remoteCredentialPaths(paths));
    await saveRemoteConfig(paths, next.data);
    console.log(JSON.stringify({ enabled: true, endpoint: `${options.origin.replace(/\/$/, '')}/mcp`, restartRequired: true, authentication: 'private-bearer', oauth: false }, null, 2)); return true;
  } finally { await lock.release(); }
}
