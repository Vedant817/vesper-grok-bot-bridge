import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { bridgeApplication } from '../bridge/application.js';
import { McpConnection } from '../adapters/mcp.js';
import { serveHttp } from '../server.js';
import type { Services } from '../server.js';
import { readCredential } from './credentials.js';
import { Redactor } from '../safety.js';
import type { ManagedPaths } from './paths.js';
export { connectManaged } from './proxy.js';

const receiptSchema = z.object({ url: z.string().url(), pid: z.number().int().positive(), instanceId: z.string().uuid(), startedAt: z.string().datetime() }).strict();
export type ManagedReceipt = z.infer<typeof receiptSchema>;
export type ManagedHealth = { running: true; receipt: ManagedReceipt } | { running: false; reason: string };
const digest = (value: string) => createHash('sha256').update(value).digest();
async function lease(paths: ManagedPaths): Promise<() => Promise<void>> {
  const guard = join(paths.home, 'daemon-acquisition'), owner = join(paths.home, 'daemon-owner.json'), id = randomUUID();
  try { await mkdir(guard, { mode: 0o700 }); } catch { throw new Error('Managed bridge startup is already in progress'); }
  try {
    try {
      const previous = z.object({ pid: z.number().int().positive(), id: z.string().uuid() }).parse(JSON.parse(await readFile(owner, 'utf8')));
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Managed bridge already has a live owner');
      await unlink(owner);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(owner, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
  } finally { await rmdir(guard); }
  return async () => { try { if (JSON.parse(await readFile(owner, 'utf8')).id === id) await unlink(owner); } catch {} };
}

async function startupError(paths: ManagedPaths, token: string, error: unknown): Promise<void> {
  // Configuration may contain arbitrary secrets. Only record a fixed diagnostic,
  // never a provider error, config body, raw subprocess output or secret values.
  const message = error instanceof Error && /^(Enrollment required:|Managed bridge already|Managed bridge startup)/.test(error.message)
    ? error.message : 'Managed bridge startup failed; run doctor to check owner enrollment, installation, and credentials';
  await writeFile(join(paths.home, 'startup-error.json'), JSON.stringify({ at: new Date().toISOString(), message: new Redactor([token]).redact(message) }), { mode: 0o600 }).catch(() => {});
}
function pipePath(paths: ManagedPaths, instanceId: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\grok-agent-bridge-${digest(paths.home).toString('hex').slice(0, 16)}-${instanceId}` : join(paths.home, `control-${instanceId}.sock`);
}
async function receiptAt(paths: ManagedPaths): Promise<ManagedReceipt> {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(paths.receipt, 'utf8')));
  const url = new URL(receipt.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Invalid local runtime receipt');
  return receipt;
}
async function control(paths: ManagedPaths, receipt: ManagedReceipt, action: 'status' | 'stop'): Promise<ManagedReceipt> {
  const token = await readCredential(paths);
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath(paths, receipt.instanceId));
    let output = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else {
      try { const value = receiptSchema.parse(JSON.parse(output)); if (value.instanceId !== receipt.instanceId || value.url !== receipt.url || value.pid !== receipt.pid) throw new Error(); resolve(value); }
      catch { reject(new Error('Managed runtime identity could not be verified')); }
    } };
    socket.setTimeout(3000, () => finish(new Error('Managed runtime is unresponsive')));
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(JSON.stringify({ token, action, instanceId: receipt.instanceId }) + '\n'));
    socket.on('data', (chunk: string) => { output += chunk; if (output.length > 8192) finish(new Error('Invalid managed runtime response')); else if (output.includes('\n')) finish(); });
    socket.on('error', () => finish(new Error('Managed runtime is unavailable'))); socket.on('end', () => finish(new Error('Managed runtime did not respond')));
  });
}

/** Starts only an owner-enrolled bridge; startup never invents repository permissions. */
export async function runManagedDaemon(paths: ManagedPaths, servicesOverride?: Services & { bridge?: { close(): Promise<void> } }): Promise<{ receipt: ManagedReceipt; close(): Promise<void> }> {
  const token = await readCredential(paths);
  const releaseLease = await lease(paths);
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
        const request = z.object({ token: z.string().max(128), action: z.enum(['status', 'stop']), instanceId: z.literal(receipt.instanceId) }).strict().parse(JSON.parse(input));
        if (!timingSafeEqual(digest(request.token), digest(token))) { socket.destroy(); return; }
        socket.end(JSON.stringify(receipt) + '\n');
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

export async function healthManaged(paths: ManagedPaths): Promise<ManagedHealth> {
  try {
    const receipt = await control(paths, await receiptAt(paths), 'status');
    const connection = await McpConnection.connect(receipt.url + '/mcp', await readCredential(paths));
    try { await connection.client.listTools({}, { timeout: 5000 }); } finally { await connection.close(); }
    return { running: true, receipt };
  } catch { return { running: false, reason: 'Managed bridge is stopped, unavailable, or its local identity could not be verified' }; }
}

export async function stopManaged(paths: ManagedPaths): Promise<{ stopped: boolean }> {
  let receipt: ManagedReceipt;
  try { receipt = await receiptAt(paths); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stopped: true }; throw error; }
  await control(paths, receipt, 'stop');
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
  let launchError = false, exited = false; child.on('error', () => { launchError = true; }); child.on('exit', () => { exited = true; }); child.unref();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !launchError) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await healthManaged(paths); if (state.running) return state.receipt;
    if (exited) break;
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
