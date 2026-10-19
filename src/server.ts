import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import type { Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Reasoner } from './contracts.js';
import type { RunResult } from './supervisor.js';
import { classifyPermission, Redactor } from './safety.js';

export interface Services {
  repository: string;
  reasoner?: Reasoner;
  redactor: Redactor;
  run?: (goal: string, signal: AbortSignal) => Promise<RunResult & { worktree: string }>;
}
export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: 'grok-autonomous-supervisor', version: '0.1.0' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: services.redactor.redact(JSON.stringify(value)) }] });
  server.registerTool('permission_evaluate', {
    description: 'Classify a structured operation using deterministic safety policy. Reports a verdict; never executes the operation.',
    inputSchema: { executable: z.string().max(256).optional(), args: z.array(z.string().max(4096)).max(100).optional(), command: z.string().max(8192).optional(), cwd: z.string().max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async request => result(classifyPermission(request, services.repository)));
  server.registerTool('question_resolve', {
    description: 'Resolve a technical question against supplied non-sensitive context with the configured Grok model. Cannot grant permissions.',
    inputSchema: { question: z.string().min(1).max(2000), context: z.string().max(6000), options: z.array(z.string().max(256)).max(20).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, async ({ question, context, options }, extra) => {
    if (!services.reasoner) throw new Error('Grok model is not configured');
    return result({ answer: await services.reasoner.answer(services.redactor.redact(question), services.redactor.redact(context), options?.map(o => services.redactor.redact(o)), extra.signal) });
  });
  if (services.run) server.registerTool('supervisor_run', {
    description: 'Run one bounded task in a fresh git worktree using the owner-configured worker and verifier. Retains worktree; never merges or pushes.',
    inputSchema: { goal: z.string().min(1).max(4000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ goal }, extra) => result(await services.run!(goal, extra.signal)));
  return server;
}
export async function serveStdio(services: Services): Promise<McpServer> {
  const server = createMcpServer(services); await server.connect(new StdioServerTransport()); return server;
}
export async function serveHttp(services: Services, token: string, port = 0): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  if (token.length < 24) throw new Error('MCP_SERVER_TOKEN must contain at least 24 characters');
  const app = express(), expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const live = new Set<McpServer>();
  const sessions = new Map<string, { server: McpServer; transport: SSEServerTransport; timer: NodeJS.Timeout }>();
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) { res.status(403).end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.status(403).end(); return; }
    if (!timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), expected)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.post('/mcp', async (req, res) => {
    if (live.size >= 16) { res.status(429).end(); return; }
    const server = createMcpServer(services); live.add(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { live.delete(server); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { live.delete(server); await server.close().catch(() => {}); if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  });
  app.all('/mcp', (_req, res) => { res.status(405).end(); });
  app.get('/sse', async (_req, res) => {
    if (sessions.size >= 16) { res.status(429).end(); return; }
    const server = createMcpServer(services), transport = new SSEServerTransport('/messages', res);
    const timer = setTimeout(() => { sessions.delete(transport.sessionId); void server.close(); }, 600000); timer.unref();
    sessions.set(transport.sessionId, { server, transport, timer });
    res.on('close', () => { sessions.delete(transport.sessionId); clearTimeout(timer); void server.close(); });
    try { await server.connect(transport); } catch { clearTimeout(timer); sessions.delete(transport.sessionId); await server.close().catch(() => {}); }
  });
  app.post('/messages', async (req, res) => {
    const session = sessions.get(String(req.query.sessionId));
    if (!session) { res.status(404).end(); return; }
    try { await session.transport.handlePostMessage(req, res, req.body); }
    catch { if (!res.headersSent) res.status(400).end(); }
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: 'Invalid request' }); });
  const server = await new Promise<Server>((resolve, reject) => { const listener = app.listen(port, '127.0.0.1', () => resolve(listener)); listener.once('error', reject); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP bind failed');
  return { server, url: `http://127.0.0.1:${address.port}`, close: async () => {
    for (const session of sessions.values()) { clearTimeout(session.timer); await session.server.close().catch(() => {}); }
    sessions.clear(); await Promise.all([...live].map(s => s.close().catch(() => {}))); live.clear();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
