#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema } from './config.js';
import { application } from './application.js';
import { serveHttp, serveStdio } from './server.js';
import { Redactor } from './safety.js';
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
export { orderTasks } from './task-graph.js';
export type { Worker, WorkerEvent, Reasoner } from './contracts.js';
export type { Config } from './config.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [mode, file, ...rest] = args;
  if (!mode || mode === '--help') {
    console.log('Usage: grok-supervisor run <config.json> <goal>\n       grok-supervisor serve-stdio <config.json>\n       grok-supervisor serve-http <config.json> [port]\n\nCredentials: XAI_API_KEY, T3_BEARER_TOKEN, MCP_SERVER_TOKEN. Config commands are trusted owner input.'); return;
  }
  if (!['run', 'serve-stdio', 'serve-http'].includes(mode) || !file) throw new Error('Invalid command; use --help');
  const config = configSchema.parse(JSON.parse(await readFile(resolve(file), 'utf8')));
  const services = await application(config), abort = new AbortController();
  const stop = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (mode === 'run') {
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
