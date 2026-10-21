import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, access, cp, copyFile, open, unlink, rm, readdir, lstat, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { managedPaths } from './paths.js';
import { ensureCredential, hardenHome } from './credentials.js';
import { processAlive } from './process.js';
import { startManaged, stopManaged, daemonStatus } from './runtime.js';
import { installAutostart, removeAutostart } from './startup.js';
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
  // Delayed expansion would consume a `!` in the home path before the child sees it.
  return '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode "%~dp0..\\launcher.cjs" %*\r\n';
}
export interface SetupOptions { home?: string; repository?: string; registerClients?: boolean; autostart?: boolean; verify?: VerifyCommand; forceSetupLock?: boolean }
async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
}
async function atomicWrite(file: string, value: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    // rename removes the temporary on success; this cleanup covers a failed write or rename.
    await unlink(temporary).catch(() => {});
  }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}
async function atomicText(file: string, value: string): Promise<void> {
  await atomicWrite(file, value);
}
async function readJsonOrQuarantine(file: string): Promise<any | undefined> {
  try { return await readJson(file); }
  catch (error) {
    // Preserve a damaged owner file instead of failing every later setup or silently
    // overwriting it; a fresh configuration can then be created and re-enrolled.
    if (error instanceof SyntaxError) {
      await rename(file, `${file}.invalid-${Date.now()}`).catch(() => {});
      return undefined;
    }
    throw error;
  }
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
  // A token mismatch must not hide a live daemon from the stop/restart decision.
  const wasRunning = restart && (await daemonStatus(paths)).running;
  const previousConfig = await readFile(paths.config, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (wasRunning) await stopManaged(paths);
  try {
    await atomicJson(paths.config, config);
    if (wasRunning) await startManaged(paths);
  } catch (error) {
    // A rejected configuration or a failed daemon restart must restore the prior state,
    // including when the config write itself failed and left the old file (or nothing).
    // Restoration is best-effort so it cannot replace the original failure.
    if (previousConfig === undefined) await unlink(paths.config).catch(() => {});
    else await atomicText(paths.config, previousConfig).catch(() => {});
    if (wasRunning) await startManaged(paths).catch(() => {});
    throw error;
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
 * Reclaim a setup lock when its owner is provably gone, when an unparseable file is old
 * enough to be past a concurrent write, or when the caller explicitly forces recovery
 * (a replaced PID can otherwise look live forever). A live, parseable owner is never
 * stolen by age alone: a suspended setup could still resume and race a second one.
 */
async function staleSetupLock(file: string, force: boolean): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  let owner: { pid: number } | undefined;
  try { owner = z.object({ pid: z.number().int().positive(), id: z.string().uuid() }).passthrough().parse(JSON.parse(raw)); }
  catch { owner = undefined; }
  const info = await lstat(file).catch(() => undefined);
  const age = info ? Date.now() - info.mtimeMs : 0;
  if (!force) {
    if (owner && processAlive(owner.pid)) return false;
    if (!owner && age < 30000) return false;
  }
  // Claim exactly the lock that was inspected before deleting it. A concurrent setup may
  // have replaced it between the read and the rename; deleting blindly would let two run.
  const claimed = `${file}.stale.${randomUUID()}`;
  try { await rename(file, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  const observed = await readFile(claimed, 'utf8').catch(() => undefined);
  if (observed === raw) { await unlink(claimed).catch(() => {}); return true; }
  // It changed after inspection: restore it without overwriting whatever now holds the name.
  await link(claimed, file).catch(() => {});
  await unlink(claimed).catch(() => {});
  return false;
}

export async function acquireSetupLock(file: string, force = false): Promise<{ release(): Promise<void> }> {
  const id = randomUUID();
  for (let attempt = 0; ; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && await staleSetupLock(file, force)) continue;
      throw new Error(`Another setup is running, or an interrupted setup left ${file}. Wait for the other setup to exit; a lock whose process is gone is reclaimed automatically. If the recorded PID was reused by an unrelated process, rerun with --force-setup-lock.`);
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, id, startedAt: new Date().toISOString() })); }
    catch (error) { await handle.close().catch(() => {}); await unlink(file).catch(() => {}); throw error; }
    return {
      release: async () => {
        await handle.close().catch(() => {});
        // Claim before deleting: a newer setup may have replaced the lock since it was read.
        const claimed = `${file}.release.${id}`;
        try { await rename(file, claimed); } catch { return; }
        const observed = await readFile(claimed, 'utf8').catch(() => undefined);
        let mine = false;
        try { mine = JSON.parse(observed ?? '').id === id; } catch {}
        if (!mine) await link(claimed, file).catch(() => {});
        await unlink(claimed).catch(() => {});
      }
    };
  }
}

export async function setupManaged(options: SetupOptions = {}): Promise<Record<string, unknown>> {
  const paths = managedPaths(options.home);
  await hardenHome(paths);
  const lock = await acquireSetupLock(join(paths.home, 'setup.lock'), options.forceSetupLock === true);
  try { return await setupUnlocked(options); }
  finally { await lock.release(); }
}
async function setupUnlocked(options: SetupOptions): Promise<Record<string, unknown>> {
  const paths = managedPaths(options.home);
  await hardenHome(paths);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pkg = await readJson(join(source, 'package.json'));
  if (!pkg?.name) throw new Error('Installation package metadata unavailable');
  await access(join(source, 'dist', 'index.js'));
  const stage = join(paths.home, 'releases', `${pkg.version}-${randomUUID()}`);
  const npm = await npmLaunch(), entrypoint = join(stage, 'dist', 'index.js');
  let lockHash = '', activated = false, inspected = false;
  let previous: any, previousConfig: string | undefined;
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
    // Only touch owner state after the new release is known to load, so a failed stage
    // cannot quarantine or replace a working installation.
    let config = await readJsonOrQuarantine(paths.config);
    if (config !== undefined && (!config || typeof config !== 'object' || !Array.isArray(config.roots))) {
      await rename(paths.config, `${paths.config}.invalid-${Date.now()}`).catch(() => {});
      config = undefined;
    }
    if (!config) await atomicJson(paths.config, { stateDirectory: join(paths.home, 'state'), roots: [] });
    previousConfig = await readFile(paths.config, 'utf8').catch(() => undefined);
    previous = await readJsonOrQuarantine(paths.installation);
    inspected = true;
    let enrollment: unknown;
    try { enrollment = await enrollManagedRepository(options.repository ?? process.cwd(), paths.home, options.verify, false); } catch (error: any) { enrollment = { enrolled: false, reason: error.message }; }
    // Stop a daemon that answers the authenticated control channel, even when the bearer
    // credential no longer matches. Rotating a token while a daemon holds the old one would
    // otherwise leave a process that cannot be authenticated, stopped, or restarted.
    if ((await daemonStatus(paths)).running) await stopManaged(paths);
    await ensureCredential(paths);
    const pty = await run(process.execPath, ['--input-type=module', '-e', 'const p=await import("node-pty");const t=p.spawn(process.execPath,["-e",""]);t.kill();'], { cwd: stage, windowsHide: true, timeout: 20000 }).then(() => 'available', () => 'unavailable');
    await writeFile(paths.launcher, launcherSource(paths.home), { mode: 0o600 });
    await mkdir(paths.bin, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') await writeFile(join(paths.bin, 'grok-agent-bridge.cmd'), cliShim(), { mode: 0o600 });
    else await writeFile(join(paths.bin, 'grok-agent-bridge'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${paths.launcher.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o700 });
    await addUserPath(paths.bin);
    await writeFile(join(paths.home, 'GROK_BOT_INSTRUCTIONS.md'), 'Use the approved local terminal to run `grok-agent-bridge call agent_discover`. Use `grok-agent-bridge call TOOL_NAME JSON_ARGUMENTS` for bridge operations. Discover provider/model availability, spawn or import the requested session, handle pending inputs, inspect changes, run verification, and finish only after verification passes. Never read or display bridge credentials. The bridge must run on this computer; cloud-only execution cannot reach it.\n', { mode: 0o600 });
    // Publish the installation only after the launcher and shim exist, so a failure cannot
    // leave doctor (or a client) pointing at files that were never written.
    await atomicJson(paths.installation, { entrypoint, node: process.execPath, version: pkg.version, dependencyLockSha256: lockHash, pty, installedAt: new Date().toISOString(), previous: previous ? { entrypoint: previous.entrypoint, node: previous.node, version: previous.version } : undefined });
    activated = true;
    const current = await readJson(paths.config), enrolled = current.roots.length > 0;
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
    if (!inspected) {
      // Staging failed before any owner or installation state was touched.
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (activated && previous) {
      // The new installation was published, then a later step failed. Put the prior
      // release and enrollment back and restore the daemon before reporting the error.
      await stopManaged(paths).catch(() => {});
      await atomicJson(paths.installation, previous).catch(() => {});
      if (previousConfig !== undefined) await atomicText(paths.config, previousConfig).catch(() => {});
      await startManaged(paths).catch(() => {});
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    } else if (!activated) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      if (previous) {
        // A failed attempt may have enrolled a root or stopped the old daemon; restore the
        // previous configuration and service. Staging failures leave the daemon untouched.
        if (previousConfig !== undefined) await atomicText(paths.config, previousConfig).catch(() => {});
        await startManaged(paths).catch(() => {});
      } else {
        // First attempt failed before publishing an installation. Remove the partial
        // launcher, shim and instructions; otherwise a later doctor would look healthy.
        await removeAutostart(paths).catch(() => {});
        await unlink(paths.installation).catch(() => {});
        await unlink(paths.launcher).catch(() => {});
        await rm(paths.bin, { recursive: true, force: true }).catch(() => {});
        await unlink(join(paths.home, 'GROK_BOT_INSTRUCTIONS.md')).catch(() => {});
      }
    }
    throw error;
  }
}
