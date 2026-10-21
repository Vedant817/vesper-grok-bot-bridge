import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { bridgeApplication } from '../bridge/application.js';
import { McpConnection } from '../adapters/mcp.js';
import { serveHttp } from '../server.js';
import type { Services } from '../server.js';
import { hardenHome, readCredential } from './credentials.js';
import { controlMac, controlPipe, ensureControlKey, sameMac } from './control.js';
import { processAlive } from './process.js';
import { Redactor } from '../safety.js';
import type { ManagedPaths } from './paths.js';
export { connectManaged } from './proxy.js';

const receiptSchema = z.object({ url: z.string().url(), pid: z.number().int().positive(), instanceId: z.string().uuid(), startedAt: z.string().datetime() }).strict();
export type ManagedReceipt = z.infer<typeof receiptSchema>;
export type ManagedHealth = { running: true; receipt: ManagedReceipt } | { running: false; reason: string };
const guardMarker = 'owner.json';

/**
 * An interrupted startup can leave the acquisition directory behind. Reclaim it only
 * when its marker names a dead process, or when it is old and never got a marker;
 * a guard that is merely young may belong to a competing startup that is still writing.
 */
async function staleGuard(guard: string): Promise<boolean> {
  const marker = join(guard, guardMarker);
  let raw: string | undefined;
  try { raw = await readFile(marker, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (raw !== undefined) {
    try {
      const previous = z.object({ pid: z.number().int().positive() }).passthrough().parse(JSON.parse(raw));
      // A live owner is authoritative no matter how old the guard is.
      if (processAlive(previous.pid)) return false;
    } catch {
      // Unparseable markers are judged by age below.
      const info = await lstat(marker).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < 30000) return false;
    }
  } else {
    // Only a guard old enough to have been fully written is reclaimable.
    const info = await lstat(guard).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs < 30000) return false;
  }
  // Claim the exact guard that was inspected. If a competing startup replaced it in the
  // meantime, restore it and back off rather than deleting a live acquisition.
  const claimed = `${guard}.stale.${randomUUID()}`;
  try { await rename(guard, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  const observed = await readFile(join(claimed, guardMarker), 'utf8').catch(() => undefined);
  if (observed === raw) { await rm(claimed, { recursive: true, force: true }).catch(() => {}); return true; }
  try { await rename(claimed, guard); }
  catch { await rm(claimed, { recursive: true, force: true }).catch(() => {}); }
  return false;
}

/** Publishing through link() keeps the owner file from being observed half-written. */
async function claimOwner(owner: string, id: string): Promise<void> {
  const temporary = `${owner}.${id}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
  try { await link(temporary, owner); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Returns true when the observed owner was reclaimed, false when it changed under us. */
async function reclaimOwner(owner: string): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(owner, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  let live = true;
  try { live = processAlive(z.object({ pid: z.number().int().positive(), id: z.string().uuid() }).parse(JSON.parse(raw)).pid); }
  catch {
    // A truncated file from an interrupted write is reclaimable once it is old enough;
    // a young one may still be mid-write by a competing daemon.
    const info = await lstat(owner).catch(() => undefined);
    live = !!info && Date.now() - info.mtimeMs < 30000;
  }
  if (live) throw new Error('Managed bridge already has a live owner');
  const claimed = `${owner}.stale.${randomUUID()}`;
  try { await rename(owner, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  const observed = await readFile(claimed, 'utf8').catch(() => undefined);
  if (observed === raw) { await unlink(claimed).catch(() => {}); return true; }
  await link(claimed, owner).catch(() => {});
  await unlink(claimed).catch(() => {});
  return false;
}

async function lease(paths: ManagedPaths): Promise<() => Promise<void>> {
  const guard = join(paths.home, 'daemon-acquisition'), owner = join(paths.home, 'daemon-owner.json'), id = randomUUID(), marker = join(guard, guardMarker);
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(guard, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && await staleGuard(guard)) continue;
      throw new Error('Managed bridge startup is already in progress');
    }
    try { await writeFile(marker, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rmdir(guard).catch(() => {}); throw error; }
    break;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await claimOwner(owner, id); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 0 && await reclaimOwner(owner)) continue;
        throw new Error('Managed bridge already has a live owner');
      }
    }
  } finally { await unlink(marker).catch(() => {}); await rmdir(guard).catch(() => {}); }
  return async () => { try { if (JSON.parse(await readFile(owner, 'utf8')).id === id) await unlink(owner); } catch {} };
}

async function startupError(paths: ManagedPaths, token: string, error: unknown): Promise<void> {
  // Configuration may contain arbitrary secrets. Only record a fixed diagnostic,
  // never a provider error, config body, raw subprocess output or secret values.
  const message = error instanceof Error && /^(Enrollment required:|Managed bridge already|Managed bridge startup)/.test(error.message)
    ? error.message : 'Managed bridge startup failed; run doctor to check owner enrollment, installation, and credentials';
  const file = join(paths.home, 'startup-error.json'), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ at: new Date().toISOString(), message: new Redactor([token]).redact(message) }), { mode: 0o600 });
    await rename(temporary, file);
  } catch { /* Diagnostics are best-effort; a failed start must still surface its original error. */ }
  finally { await unlink(temporary).catch(() => {}); }
}
function pipePath(paths: ManagedPaths, instanceId: string): string {
  return controlPipe(paths, instanceId);
}
/** Deletes a receipt only if it still names the instance that was observed. */
async function removeReceiptIf(paths: ManagedPaths, instanceId: string): Promise<void> {
  const claimed = `${paths.receipt}.delete.${randomUUID()}`;
  try { await rename(paths.receipt, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let current = false;
  try { const moved = receiptSchema.safeParse(JSON.parse(await readFile(claimed, 'utf8'))); current = moved.success && moved.data.instanceId !== instanceId; }
  catch { current = false; }
  // A live daemon may have replaced the stale receipt between the read and this claim.
  if (current) {
    const restored = await link(claimed, paths.receipt).then(() => true, () => false);
    if (!restored) {
      // If the name is occupied, a newer receipt is already authoritative. If it is not,
      // keep the moved file for recovery rather than deleting the only copy.
      const occupied = await lstat(paths.receipt).then(() => true, () => false);
      if (!occupied) return;
    }
  }
  await unlink(claimed).catch(() => {});
}

async function receiptAt(paths: ManagedPaths): Promise<ManagedReceipt> {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(paths.receipt, 'utf8')));
  const url = new URL(receipt.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Invalid local runtime receipt');
  return receipt;
}
async function control(paths: ManagedPaths, receipt: ManagedReceipt, action: 'status' | 'stop'): Promise<ManagedReceipt> {
  const key = await ensureControlKey(paths), nonce = randomBytes(16).toString('hex');
  const request = JSON.stringify({ v: 1, action, instanceId: receipt.instanceId, nonce, mac: controlMac(key, 'request', action, receipt.instanceId, nonce) });
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath(paths, receipt.instanceId));
    let output = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else {
      try {
        const response = z.object({ receipt: z.string().max(4096), nonce: z.literal(nonce), mac: z.string() }).strict().parse(JSON.parse(output));
        // Verify the exact receipt bytes before trusting the endpoint they name; otherwise a
        // squatter could redirect the subsequent bearer-authenticated MCP connection.
        if (!sameMac(response.mac, controlMac(key, 'response', nonce, response.receipt))) throw new Error();
        const value = receiptSchema.parse(JSON.parse(response.receipt));
        if (value.instanceId !== receipt.instanceId || value.url !== receipt.url || value.pid !== receipt.pid) throw new Error();
        resolve(value);
      } catch { reject(new Error('Managed runtime identity could not be verified')); }
    } };
    socket.setTimeout(3000, () => finish(new Error('Managed runtime is unresponsive')));
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(request + '\n'));
    socket.on('data', (chunk: string) => { output += chunk; if (output.length > 8192) finish(new Error('Invalid managed runtime response')); else if (output.includes('\n')) finish(); });
    socket.on('error', (error: NodeJS.ErrnoException) => finish(Object.assign(new Error('Managed runtime is unavailable'), { code: error.code }))); socket.on('end', () => finish(new Error('Managed runtime did not respond')));
  });
}

/** Starts only an owner-enrolled bridge; startup never invents repository permissions. */
export async function runManagedDaemon(paths: ManagedPaths, servicesOverride?: Services & { bridge?: { close(): Promise<void> } }): Promise<{ receipt: ManagedReceipt; close(): Promise<void> }> {
  await hardenHome(paths);
  const token = await readCredential(paths), key = await ensureControlKey(paths);
  let releaseLease: () => Promise<void>;
  try { releaseLease = await lease(paths); }
  catch (error) { await startupError(paths, token, error); throw error; }
  let services = servicesOverride;
  try {
    if (!services) {
      const config = JSON.parse(await readFile(paths.config, 'utf8')) as { roots?: unknown[] };
      if (!Array.isArray(config.roots) || !config.roots.length) throw new Error('Enrollment required: add a trusted repository and verification command with setup');
      services = await bridgeApplication(config);
    }
  } catch (error) { await startupError(paths, token, error); await releaseLease(); throw error; }
  let http: Awaited<ReturnType<typeof serveHttp>>;
  try { http = await serveHttp(services, token, 0); }
  catch (error) { await services.bridge?.close(); await releaseLease(); await startupError(paths, token, error); throw error; }
  const receipt: ManagedReceipt = { url: http.url, pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() };
  const pipe = pipePath(paths, receipt.instanceId);
  const accepted = new Set<string>(), acceptedOrder: string[] = [];
  let closing: Promise<void> | undefined;
  const stopSignal = () => { void close().catch(() => {}); };
  const server = createServer(socket => {
    let input = '', handled = false;
    socket.setTimeout(3000, () => socket.destroy()); socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (input.length > 8192) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try {
        const request = z.object({ v: z.literal(1), action: z.enum(['status', 'stop']), instanceId: z.literal(receipt.instanceId), nonce: z.string().regex(/^[a-f0-9]{32}$/), mac: z.string() }).strict().parse(JSON.parse(input));
        if (!sameMac(request.mac, controlMac(key, 'request', request.action, receipt.instanceId, request.nonce))) { socket.destroy(); return; }
        if (accepted.has(request.nonce)) { socket.destroy(); return; }
        accepted.add(request.nonce); acceptedOrder.push(request.nonce);
        if (acceptedOrder.length > 256) accepted.delete(acceptedOrder.shift()!);
        const body = JSON.stringify(receipt);
        socket.end(JSON.stringify({ receipt: body, nonce: request.nonce, mac: controlMac(key, 'response', request.nonce, body) }) + '\n');
        if (request.action === 'stop') setImmediate(stopSignal);
      } catch { socket.destroy(); }
    });
  });
  async function close(): Promise<void> {
    if (!closing) closing = (async () => {
      process.removeListener('SIGINT', stopSignal); process.removeListener('SIGTERM', stopSignal);
      await Promise.allSettled([http.close(), services!.bridge?.close(), new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); })]);
      try { if ((await receiptAt(paths)).instanceId === receipt.instanceId) await unlink(paths.receipt); } catch {}
      if (process.platform !== 'win32') await unlink(pipe).catch(() => {});
      await releaseLease();
    })();
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, () => { server.removeListener('error', reject); server.on('error', stopSignal); resolve(); }); });
    const temporary = paths.receipt + '.' + receipt.instanceId + '.tmp';
    try { await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); await rename(temporary, paths.receipt); }
    finally { await unlink(temporary).catch(() => {}); }
  } catch (error) { await close(); await startupError(paths, token, error); throw error; }
  await unlink(join(paths.home, 'startup-error.json')).catch(() => {});
  process.once('SIGINT', stopSignal); process.once('SIGTERM', stopSignal);
  return { receipt, close };
}

/**
 * Authenticates the control channel only; never needs the bearer credential.
 * `unknown` means a live daemon cannot be ruled out (unreadable receipt, rotated or
 * missing control key, timeout). Callers must not treat it as stopped when they are
 * about to rotate credentials or rewrite owner state.
 */
export type DaemonStatus = { state: 'running'; receipt: ManagedReceipt } | { state: 'stopped' } | { state: 'unknown'; reason: string };
export async function daemonStatus(paths: ManagedPaths): Promise<DaemonStatus> {
  let receipt: ManagedReceipt;
  try { receipt = await receiptAt(paths); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'stopped' }
      : { state: 'unknown', reason: 'runtime receipt is unreadable' };
  }
  try { return { state: 'running', receipt: await control(paths, receipt, 'status') }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing pipe or a refused connection is only proof of "stopped" when the
    // recorded process is also gone. A live PID may be a daemon whose receipt was
    // replaced, or a reused PID; either way callers must not rotate underneath it.
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      return processAlive(receipt.pid)
        ? { state: 'unknown', reason: 'no control listener is reachable for the recorded live process' }
        : { state: 'stopped' };
    }
    // Any other failure could be a live daemon we cannot authenticate (for example after key loss).
    return { state: 'unknown', reason: (error as Error).message || 'control channel could not be verified' };
  }
}

export async function healthManaged(paths: ManagedPaths): Promise<ManagedHealth> {
  const state = await daemonStatus(paths);
  if (state.state !== 'running') return { running: false, reason: state.state === 'unknown' ? `Managed bridge could not be verified: ${state.reason}` : 'Managed bridge is stopped, unavailable, or its local identity could not be verified' };
  try {
    const connection = await McpConnection.connect(state.receipt.url + '/mcp', await readCredential(paths));
    try { await connection.client.listTools({}, { timeout: 5000 }); } finally { await connection.close(); }
    return { running: true, receipt: state.receipt };
  } catch { return { running: false, reason: 'Managed bridge is stopped, unavailable, or its local identity could not be verified' }; }
}

export async function stopManaged(paths: ManagedPaths): Promise<{ stopped: boolean }> {
  let receipt: ManagedReceipt;
  try { receipt = await receiptAt(paths); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stopped: true }; throw error; }
  try { await control(paths, receipt, 'stop'); }
  catch (error) {
    // A crash, reboot, or forced kill leaves a valid receipt with no listener. Reclaim it
    // only when the recorded process is provably gone; a live but unresponsive daemon is
    // still an error because terminating it blindly could kill a reused pid.
    if (!processAlive(receipt.pid)) {
      await removeReceiptIf(paths, receipt.instanceId).catch(() => {});
      if (process.platform !== 'win32') await unlink(pipePath(paths, receipt.instanceId)).catch(() => {});
      return { stopped: true };
    }
    throw error;
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const current = await receiptAt(paths); if (current.instanceId !== receipt.instanceId) return { stopped: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stopped: true }; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Managed bridge did not finish shutdown within 15 seconds');
}

export async function startManaged(paths: ManagedPaths): Promise<ManagedReceipt> {
  const current = await healthManaged(paths); if (current.running) return current.receipt;
  const config = JSON.parse(await readFile(paths.config, 'utf8')) as { roots?: unknown[] };
  if (!Array.isArray(config.roots) || !config.roots.length) throw new Error('Enrollment required: add a trusted repository and verification command with setup');
  if (!(await lstat(paths.launcher)).isFile()) throw new Error('Managed launcher is missing; rerun setup');
  const child = spawn(process.execPath, [paths.launcher, 'daemon'], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, GROK_AGENT_BRIDGE_HOME: paths.home } });
  let launchError = false; child.on('error', () => { launchError = true; }); child.unref();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !launchError) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await healthManaged(paths); if (state.running) return state.receipt;
    // A logon task or another client can win startup while this child exits.
    // Wait for the authenticated winner within the same bounded startup budget.
  }
  throw new Error('Managed bridge could not start; run doctor to inspect enrollment, credentials, and installation');
}

export async function managedConnection(paths: ManagedPaths): Promise<McpConnection> {
  const state = await healthManaged(paths);
  const receipt = state.running ? state.receipt : await startManaged(paths);
  return McpConnection.connect(receipt.url + '/mcp', await readCredential(paths));
}

export async function callManaged(paths: ManagedPaths, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!/^agent_[a-z_]+$/.test(tool)) throw new Error('Only coding-agent bridge tools are available');
  const connection = await managedConnection(paths);
  try { return await connection.call(tool, args); } finally { await connection.close(); }
}
