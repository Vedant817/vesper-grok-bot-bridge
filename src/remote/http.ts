import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** HTTPS is terminated by the owner's tunnel. This listener is never exposed on a LAN. */
export async function serveRemote(options: { origin: string; token: string; createServer: () => Server; port?: number }): Promise<{ server: HttpServer; url: string; close: () => Promise<void> }> {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || ![origin.origin, `${origin.origin}/`].includes(options.origin)) throw new Error('Remote origin must be an HTTPS origin');
  if (options.token.length < 32 || /[\r\n]/.test(options.token)) throw new Error('Remote token must contain at least 32 characters');
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  type Session = { server: Server; transport: StreamableHTTPServerTransport; timer?: NodeJS.Timeout; closed: boolean };
  const sessions = new Map<string, Session>(), live = new Set<Session>();
  let closing = false, localHost = '';
  const dispose = async (session: Session) => {
    if (session.closed) return;
    session.closed = true; clearTimeout(session.timer); live.delete(session);
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    await session.server.close().catch(() => {});
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Read raw Host: forwarded headers and Express proxy interpretation are irrelevant.
    if (req.headers.host !== origin.host && req.headers.host !== localHost) { res.status(403).end(); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== origin.origin) { res.status(403).end(); return; }
    if (!timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), expected)) { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Unauthorized' }); return; }
    if (closing) { res.status(503).end(); return; }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.all('/mcp', async (req, res) => {
    // Express accepts a trailing slash by default; expose exactly one route.
    if (req.originalUrl !== '/mcp') { res.status(404).end(); return; }
    const id = req.headers['mcp-session-id'];
    let session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) {
      if (id !== undefined) { res.status(404).end(); return; }
      if (req.method !== 'POST' || req.body?.method !== 'initialize') { res.status(405).end(); return; }
      if (live.size >= 16) { res.status(429).end(); return; }
      try {
        const server = options.createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: assigned => { if (!session!.closed) sessions.set(assigned, session!); } });
        session = { server, transport, closed: false }; live.add(session);
        const current = session, previousClose = server.onclose;
        server.onclose = () => { try { previousClose?.(); } finally { void dispose(current); } };
        await server.connect(transport);
      } catch {
        if (session) await dispose(session);
        res.status(500).json({ error: 'MCP connection failed' }); return;
      }
    }
    clearTimeout(session.timer);
    const current = session;
    session.timer = setTimeout(() => { void dispose(current); }, 3_600_000); session.timer.unref();
    try {
      await session.transport.handleRequest(req, res, req.body);
      if (!session.transport.sessionId) await dispose(session);
    } catch {
      await dispose(session);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  app.use((_req, res) => { res.status(404).end(); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: 'Invalid request' });
  });
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(options.port ?? 0, '127.0.0.1', () => resolve(listener)); listener.once('error', reject);
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Remote listener bind failed');
  localHost = `127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return { server, url: `http://${localHost}`, close: () => closePromise ??= (async () => {
    closing = true;
    await Promise.all([...live].map(dispose)); sessions.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  })() };
}
