#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema } from './config.js';
import { application } from './application.js';
import { serveHttp, serveStdio } from './server.js';
import { Redactor } from './safety.js';
import { z } from 'zod';
import { runTaskGraph } from './task-graph.js';
import { bridgeApplication } from './bridge/application.js';
import { McpConnection } from './adapters/mcp.js';
export { BridgeService } from './bridge/service.js';
export { bridgeApplication } from './bridge/application.js';
export { discoverProviders } from './bridge/provider.js';
export { Supervisor } from './supervisor.js';
export { Memory } from './memory.js';
export { GrokReasoner } from './grok.js';
export { classifyPermission, Redactor } from './safety.js';
export { createWorktree, changes } from './worktree.js';
export { AcpWorker } from './adapters/acp.js';
export { CodexWorker } from './adapters/codex.js';
export { T3Worker } from './adapters/t3.js';
export { PtyWorker } from './adapters/pty.js';
export { McpConnection } from './adapters/mcp.js';
export { createMcpServer, serveHttp, serveStdio } from './server.js';
export { orderTasks, runTaskGraph } from './task-graph.js';
export type { Worker, WorkerEvent, Reasoner } from './contracts.js';
export type { Config } from './config.js';
async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(resolve(file), 'utf8')); }
  catch { throw new Error('Unable to read valid JSON from the supplied configuration file'); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [mode, file, ...rest] = args;
  if (mode === 'bridge-call') {
    if (!file || !rest[0] || !rest[0].startsWith('agent_')) throw new Error('Usage: grok-supervisor bridge-call <loopback MCP URL> <agent_tool> <arguments.json>');
    const args = rest[1] ? await readJson(rest[1]) : {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
    const client = await McpConnection.connect(file, process.env.MCP_SERVER_TOKEN ?? '');
    try { console.log(JSON.stringify(await client.call(rest[0], args as Record<string, unknown>), null, 2)); }
    finally { await client.close(); } return;
  }
  if (mode === 'bridge-stdio' || mode === 'bridge-http' || mode === 'bridge-discover') {
    if (!file) throw new Error('Bridge owner configuration JSON required');
    const services = await bridgeApplication(await readJson(file));
    if (mode === 'bridge-discover') { console.log(JSON.stringify(services.bridge.discover(), null, 2)); await services.bridge.close(); return; }
    let shutdown: () => Promise<unknown>;
    try { if (mode === 'bridge-stdio') {
      const server = await serveStdio(services); shutdown = () => server.close();
      const previous = server.server.onclose;
      server.server.onclose = () => { previous?.(); void services.bridge.close(); };
    } else {
      const port = rest[0] ? Number(rest[0]) : 3001;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
      const server = await serveHttp(services, process.env.MCP_SERVER_TOKEN ?? '', port); shutdown = server.close;
      console.error(`Coding agent bridge listening on ${server.url}/mcp (legacy: /sse)`);
    } } catch (error) { await services.bridge.close(); throw error; }
    const stop = () => { void services.bridge.close().finally(shutdown); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (!mode || mode === '--help') {
    console.log('Usage: grok-supervisor bridge-stdio <owner.json>\n       grok-supervisor bridge-http <owner.json> [port]\n       grok-supervisor bridge-discover <owner.json>\n       grok-supervisor bridge-call <loopback MCP URL> <agent_tool> [arguments.json]\n\nLegacy autonomous mode: run <config.json> <goal> | run-plan <config.json> <tasks.json>\nLegacy MCP: serve-stdio <config.json> | serve-http <config.json> [port]\n\nBridge: no XAI_API_KEY required. Native agents use their own authentication. HTTP needs MCP_SERVER_TOKEN; T3 needs T3_BEARER_TOKEN. Owner config selects trusted roots and verifier commands.'); return;
  }
  if (!['run', 'run-plan', 'serve-stdio', 'serve-http'].includes(mode) || !file) throw new Error('Invalid command; use --help');
  const config = configSchema.parse(await readJson(file));
  const services = await application(config), abort = new AbortController();
  const stop = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (mode === 'run-plan') {
    if (!rest[0]) throw new Error('Task plan JSON path required');
    const tasks = z.array(z.object({ id: z.string().min(1), goal: z.string().min(1).max(3000), dependsOn: z.array(z.string()) }).strict()).min(1).max(100).parse(await readJson(rest[0]));
    try {
      const results = await runTaskGraph(tasks, async (task, dependencies) => services.run!(`${task.goal}\nCompleted dependency worktrees (read-only context; do not mutate): ${JSON.stringify(dependencies)}`, abort.signal));
      console.log(JSON.stringify(results, null, 2)); if (Object.values(results).some(r => r.state !== 'completed')) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else if (mode === 'run') {
    const goal = rest.join(' '); if (!goal) throw new Error('A nonempty task goal is required');
    try { const result = await services.run!(goal, abort.signal); console.log(JSON.stringify(result, null, 2)); if (result.state !== 'completed') process.exitCode = 1; }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else if (mode === 'serve-stdio') {
    const server = await serveStdio(services);
    abort.signal.addEventListener('abort', () => { void server.close(); }, { once: true });
  } else {
    const port = rest[0] ? Number(rest[0]) : 3001; if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
    const server = await serveHttp(services, process.env.MCP_SERVER_TOKEN ?? '', port);
    console.error(`Supervisor MCP listening on ${server.url}/mcp (legacy: /sse)`);
    abort.signal.addEventListener('abort', () => { void server.close(); }, { once: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(new Redactor([process.env.XAI_API_KEY ?? '', process.env.T3_BEARER_TOKEN ?? '', process.env.MCP_SERVER_TOKEN ?? '']).redact(String(error))); process.exitCode = 1; });
}
