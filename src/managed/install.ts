import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, access, cp, copyFile, open, unlink, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { managedPaths } from './paths.js';
import { ensureCredential, hardenHome } from './credentials.js';
import { processAlive } from './process.js';
import { startManaged, stopManaged, healthManaged } from './runtime.js';
import { installAutostart } from './startup.js';
import { registerManagedClients } from './clients.js';
import { powershellPath } from './powershell.js';

const run = promisify(execFile);
export interface VerifyCommand { executable: string; args: string[] }
/**
 * cmd.exe decodes batch files in the OEM code page, so a literal non-ASCII home would be
 * corrupted. Keep the shim ASCII and resolve the launcher at runtime from %~dp0 (which
 * comes from the Unicode command line). Node is taken from PATH because it cannot be
 * embedded without re-introducing the encoding problem.
 */
export function cliShim(): string {
  return '@echo off\r\nnode "%~dp0..\\launcher.cjs" %*\r\n';
}
export interface SetupOptions { home?: string; repository?: string; registerClients?: boolean; autostart?: boolean; verify?: VerifyCommand }
async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
async function atomicText(file: string, value: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
}
export async function npmLaunch(): Promise<VerifyCommand> {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter((s): s is string => !!s);
  for (const file of candidates) { try { await access(file); return { executable: process.execPath, args: [file] }; } catch {} }
  throw new Error('npm CLI is unavailable. Install Node.js with npm before setup.');
}
export async function repositoryRoot(directory: string): Promise<string> {
  const result = await run('git', ['-C', resolve(directory), 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 10000 });
  return resolve(result.stdout.trim());
}
export async function inferVerifier(directory: string, explicit?: VerifyCommand): Promise<VerifyCommand | undefined> {
  if (explicit) {
    if (!explicit.executable.trim() || !Array.isArray(explicit.args) || explicit.args.some(arg => typeof arg !== 'string')) throw new Error('Verifier must specify executable and an argument array');
    return explicit;
  }
  const pkg = await readJson(join(directory, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const script = ['check', 'test'].find(key => typeof scripts[key] === 'string' && scripts[key].trim() && !/no test specified|exit\s+0\b|echo\s+["']?(?:ok|pass)/i.test(scripts[key]));
  if (!script) return;
  const npm = await npmLaunch();
  return { executable: npm.executable, args: [...npm.args, 'run', script] };
}
export async function enrollManagedRepository(repository: string, home?: string, verify?: VerifyCommand, restart = true): Promise<{ directory: string; enrolled: boolean; reason?: string }> {
  const paths = managedPaths(home);
  await hardenHome(paths);
  const directory = await repositoryRoot(repository), command = await inferVerifier(directory, verify);
  if (!command) return { directory, enrolled: false, reason: 'No verification script found. Enroll with an explicit verifier executable and arguments.' };
  const config = await readJson(paths.config) ?? { stateDirectory: join(paths.home, 'state'), roots: [] };
  if (!Array.isArray(config.roots)) throw new Error('Existing owner configuration has invalid roots; it was preserved');
  const existing = config.roots.find((root: any) => resolve(root.directory) === directory);
  if (existing && (!verify || JSON.stringify(existing.verify) === JSON.stringify(command))) return { directory, enrolled: true };
  if (existing) existing.verify = command;
  else config.roots.push({ directory, verify: command });
  const wasRunning = restart && (await healthManaged(paths)).running;
  const previousConfig = await readFile(paths.config, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (wasRunning) await stopManaged(paths);
  await atomicJson(paths.config, config);
  if (wasRunning) {
    try { await startManaged(paths); }
    catch (error) {
      // Never leave the daemon down on a rejected configuration; restore what previously started.
      if (previousConfig === undefined) await unlink(paths.config).catch(() => {});
      else await atomicText(paths.config, previousConfig);
      await startManaged(paths).catch(() => {});
      throw error;
    }
  }
  return { directory, enrolled: true };
}
export function launcherSource(home: string): string {
  return `// Managed GrokAgentBridge launcher; configuration and authentication remain private.\n` +
    `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');\n` +
    `const home=${JSON.stringify(home)}, file=path.join(home,'installation.json');\n` +
    `try { const i=JSON.parse(fs.readFileSync(file,'utf8')); const p=cp.spawn(i.node,[i.entrypoint,...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,env:{...process.env,GROK_AGENT_BRIDGE_HOME:home}}); p.on('error',()=>{console.error('Bridge installation could not start. Run setup again.');process.exitCode=1}); p.on('exit',(code)=>process.exit(code??1)); } catch { console.error('Bridge installation is missing or invalid. Run setup again.');process.exitCode=1; }\n`;
}
async function addUserPath(bin: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const value = `'${bin.replace(/'/g, "''")}'`;
  await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $bin=${value}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(-not (($p -split ';') | Where-Object {$_.TrimEnd('\\') -ieq $bin.TrimEnd('\\')})){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';')+';'+$bin).TrimStart(';')),'User')}`], { windowsHide: true, timeout: 10000 });
  const current = process.env.PATH ?? '';
  if (!current.toLowerCase().split(';').includes(bin.toLowerCase())) process.env.PATH = `${current};${bin}`;
}
/**
 * Reclaim a setup lock only when its owner is gone. A lock file that exists but cannot
 * name a live owner is removed once it is old enough that a competing setup would have
 * finished writing it; otherwise a young, unparseable file may still be mid-write.
 */
async function staleSetupLock(file: string): Promise<boolean> {
  try {
    const previous = z.object({ pid: z.number().int().positive(), id: z.string().uuid() }).passthrough().parse(JSON.parse(await readFile(file, 'utf8')));
    if (processAlive(previous.pid)) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    const info = await lstat(file).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs < 30000) return false;
  }
  await unlink(file).catch(() => {});
  return true;
}

export async function acquireSetupLock(file: string): Promise<{ release(): Promise<void> }> {
  const id = randomUUID();
  for (let attempt = 0; ; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && await staleSetupLock(file)) continue;
      throw new Error(`Another setup is running, or an interrupted setup left ${file}. Wait for the other setup to exit; a lock whose process is gone is reclaimed automatically.`);
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, id, startedAt: new Date().toISOString() })); }
    catch (error) { await handle.close().catch(() => {}); await unlink(file).catch(() => {}); throw error; }
    return {
      release: async () => {
        await handle.close().catch(() => {});
        try { if (JSON.parse(await readFile(file, 'utf8')).id === id) await unlink(file); } catch {}
      }
    };
  }
}

export async function setupManaged(options: SetupOptions = {}): Promise<Record<string, unknown>> {
  const paths = managedPaths(options.home);
  await hardenHome(paths);
  const lock = await acquireSetupLock(join(paths.home, 'setup.lock'));
  try { return await setupUnlocked(options); }
  finally { await lock.release(); }
}
async function setupUnlocked(options: SetupOptions): Promise<Record<string, unknown>> {
  const paths = managedPaths(options.home);
  await hardenHome(paths);
  await ensureCredential(paths);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pkg = await readJson(join(source, 'package.json'));
  if (!pkg?.name || !await readJson(join(source, 'package.json'))) throw new Error('Installation package metadata unavailable');
  await access(join(source, 'dist', 'index.js'));
  const stage = join(paths.home, 'releases', `${pkg.version}-${randomUUID()}`);
  const npm = await npmLaunch(), entrypoint = join(stage, 'dist', 'index.js');
  let lockHash = '';
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await cp(join(source, 'dist'), join(stage, 'dist'), { recursive: true, errorOnExist: true, force: false });
    await copyFile(join(source, 'package.json'), join(stage, 'package.json'));
    let lockFile = join(source, 'package-lock.json');
    try { await access(lockFile); } catch { lockFile = join(source, 'runtime-lock.json'); }
    await copyFile(lockFile, join(stage, 'package-lock.json'));
    lockHash = createHash('sha256').update(await readFile(join(stage, 'package-lock.json'))).digest('hex');
    await run(npm.executable, [...npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    await access(entrypoint);
    // A fully installed package must load before the active installation is replaced.
    await run(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(entrypoint).href], { cwd: stage, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let enrollment: unknown;
  if (!await readJson(paths.config)) await atomicJson(paths.config, { stateDirectory: join(paths.home, 'state'), roots: [] });
  try { enrollment = await enrollManagedRepository(options.repository ?? process.cwd(), paths.home, options.verify, false); } catch (error: any) { enrollment = { enrolled: false, reason: error.message }; }
  const previous = await readJson(paths.installation);
  if ((await healthManaged(paths)).running) await stopManaged(paths);
  const pty = await run(process.execPath, ['--input-type=module', '-e', 'const p=await import("node-pty");const t=p.spawn(process.execPath,["-e",""]);t.kill();'], { cwd: stage, windowsHide: true, timeout: 20000 }).then(() => 'available', () => 'unavailable');
  await atomicJson(paths.installation, { entrypoint, node: process.execPath, version: pkg.version, dependencyLockSha256: lockHash, pty, installedAt: new Date().toISOString(), previous: previous ? { entrypoint: previous.entrypoint, node: previous.node, version: previous.version } : undefined });
  try {
  await writeFile(paths.launcher, launcherSource(paths.home), { mode: 0o600 });
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') await writeFile(join(paths.bin, 'grok-agent-bridge.cmd'), cliShim(), { mode: 0o600 });
  else await writeFile(join(paths.bin, 'grok-agent-bridge'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${paths.launcher.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o700 });
  await addUserPath(paths.bin);
  await writeFile(join(paths.home, 'GROK_BOT_INSTRUCTIONS.md'), 'Use the approved local terminal to run `grok-agent-bridge call agent_discover`. Use `grok-agent-bridge call TOOL_NAME JSON_ARGUMENTS` for bridge operations. Discover provider/model availability, spawn or import the requested session, handle pending inputs, inspect changes, run verification, and finish only after verification passes. Never read or display bridge credentials. The bridge must run on this computer; cloud-only execution cannot reach it.\n', { mode: 0o600 });
  const config = await readJson(paths.config), enrolled = config.roots.length > 0;
  const clients = options.registerClients === false ? { status: 'skipped' } : await registerManagedClients(paths);
  const startup = options.autostart === false ? { mode: 'disabled' } : enrolled ? await installAutostart(paths) : { mode: 'pending-enrollment' };
  let health: unknown = { ok: false, reason: 'Repository enrollment with a verifier is required' };
  if (enrolled) health = await startManaged(paths);
  // Keep the active release plus the one referenced for rollback; drop abandoned stages.
  const releases = join(paths.home, 'releases');
  const keep = new Set([stage, typeof previous?.entrypoint === 'string' ? dirname(previous.entrypoint) : undefined].filter((value): value is string => !!value));
  for (const entry of await readdir(releases, { withFileTypes: true }).catch(() => [])) {
    const directory = join(releases, entry.name);
    if (entry.isDirectory() && !keep.has(directory)) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return { home: paths.home, installedEntrypoint: entrypoint, version: pkg.version, enrollment, enrollmentRequired: !enrolled, clients, startup, health };
  } catch (error) {
    if (previous) { await stopManaged(paths).catch(() => {}); await atomicJson(paths.installation, previous); await startManaged(paths).catch(() => {}); }
    throw error;
  }
}
