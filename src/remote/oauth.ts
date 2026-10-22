import express, { type RequestHandler } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError, ServerError, UnsupportedGrantTypeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hardenHome } from '../managed/credentials.js';
import { managedPaths } from '../managed/paths.js';
import { verifyOwnerRequest } from './owner-auth.js';

const scope = 'coding:operate', lifetime = 30 * 24 * 60 * 60;
const seconds = () => Math.floor(Date.now() / 1000);
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function validRedirect(value: string): boolean {
  try { const url = new URL(value); return value.length <= 2048 && value === value.trim() && !/[\r\n\t]/.test(value) && !url.username && !url.password && !value.includes('#') && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))); }
  catch { return false; }
}
const clientSchema = z.object({ client_id: z.string().uuid(), client_id_issued_at: z.number().int(), client_name: z.string().max(200).optional(), redirect_uris: z.array(z.string().refine(validRedirect)).min(1).max(4), token_endpoint_auth_method: z.literal('none'), grant_types: z.tuple([z.literal('authorization_code')]), response_types: z.tuple([z.literal('code')]), scope: z.literal(scope) }).strict();
const stateSchema = z.object({ version: z.literal(1), clients: z.array(clientSchema).max(64), revoked: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), exp: z.number().int() }).strict()).max(256) }).strict();
type State = z.infer<typeof stateSchema>;
type Pending = { id: string; nonce: string; clientId: string; clientName?: string; params: AuthorizationParams; expiresAt: number; redirect?: string; approving?: boolean };
type Code = { clientId: string; redirectUri: string; challenge: string; expiresAt: number };
type OAuthObservation = {
  method: string; path: string; status: number;
  registration?: { bodyStage: 'parsed' | 'unavailable'; authMethod?: string; grantTypes?: string[]; responseTypes?: string[]; scopePresent?: boolean; scopeExpected?: boolean; hasClientSecret?: boolean; redirectUris?: { protocol: string; hostname?: string; hasQuery?: boolean; hasFragment?: boolean; hasCredentials?: boolean }[] };
};
const observedPaths = new Set(['/authorize', '/register', '/token', '/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/authorization/status', '/owner/pending', '/owner/clients', '/owner/revoke-client', '/owner/approve', '/owner/diagnostics']);
const observedEnum = (value: unknown, choices: readonly string[]) => typeof value !== 'string' ? 'missing' : choices.includes(value) ? value : 'unknown';
function registrationObservation(body: unknown): NonNullable<OAuthObservation['registration']> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { bodyStage: 'unavailable' };
  const value = body as Record<string, unknown>;
  const types = (input: unknown, choices: readonly string[]) => Array.isArray(input) ? input.slice(0, 8).map(item => observedEnum(item, choices)) : undefined;
  return {
    bodyStage: 'parsed', authMethod: observedEnum(value.token_endpoint_auth_method, ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt', 'tls_client_auth']),
    grantTypes: types(value.grant_types, ['authorization_code', 'refresh_token', 'client_credentials']), responseTypes: types(value.response_types, ['code', 'token', 'id_token']),
    scopePresent: Object.hasOwn(value, 'scope'), scopeExpected: value.scope === scope, hasClientSecret: Object.hasOwn(value, 'client_secret'),
    redirectUris: Array.isArray(value.redirect_uris) ? value.redirect_uris.slice(0, 8).map(input => {
      try {
        if (typeof input !== 'string' || input.length > 2048) throw new Error();
        const url = new URL(input), protocol = observedEnum(url.protocol, ['https:', 'http:']);
        // Never retain credentials, callback paths, query strings, fragments or opaque URI payloads.
        return { protocol, ...(protocol === 'unknown' ? {} : { hostname: url.hostname.slice(0, 253) }), hasQuery: url.search !== '', hasFragment: input.includes('#'), hasCredentials: Boolean(url.username || url.password) };
      } catch { return { protocol: 'invalid' }; }
    }) : undefined,
  };
}

/** Public OAuth endpoints use the SDK; owner approval remains local and private. */
export async function createRemoteOAuth(options: { origin: string; secret: string; home: string }): Promise<{ router: RequestHandler; verify(token: string): Promise<AuthInfo> }> {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || !/^[a-f0-9]{64}$/.test(options.secret)) throw new Error('Invalid remote OAuth configuration');
  const resource = `${origin.origin}/mcp`, paths = managedPaths(options.home), file = join(paths.home, 'remote-oauth.json');
  await hardenHome(paths);
  let state: State = { version: 1, clients: [], revoked: [] };
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    state = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (new Set(state.clients.map(client => client.client_id)).size !== state.clients.length) throw new Error();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid remote OAuth store'); }
  let queue: Promise<unknown> = Promise.resolve();
  const update = (change: (next: State) => void): Promise<void> => {
    const operation = queue.then(async () => {
      const next: State = structuredClone(state); next.revoked = next.revoked.filter(item => item.exp > seconds()); change(next);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file); state = next;
      } catch { throw new ServerError('Private OAuth storage failed'); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    queue = operation.catch(() => {}); return operation;
  };
  const pending = new Map<string, Pending>(), codes = new Map<string, Code>();
  const revoking = new Set<string>();
  // Anonymous DCR clients are temporary, separate from durable owner-approved clients.
  const registrations = new Map<string, { client: z.infer<typeof clientSchema>; expiresAt: number }>();
  const prune = () => {
    for (const [id, value] of registrations) if (value.expiresAt <= seconds()) registrations.delete(id);
    for (const [id, value] of pending) if (value.expiresAt <= seconds()) pending.delete(id);
    for (const [id, value] of codes) if (value.expiresAt <= seconds()) codes.delete(id);
  };
  const claimsSchema = z.object({ v: z.literal(1), jti: z.string().regex(/^[a-f0-9]{64}$/), sub: z.string().uuid(), aud: z.literal(resource), scope: z.literal(scope), iat: z.number().int(), exp: z.number().int() }).strict();
  const verify = async (token: string): Promise<AuthInfo> => {
    try {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
      const [body, signature] = token.split('.');
      const expected = createHmac('sha256', options.secret).update(body).digest('base64url');
      if (!equal(signature, expected)) throw new Error();
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      if (claims.exp <= seconds() || claims.iat > seconds() + 60 || claims.exp <= claims.iat || claims.exp - claims.iat > lifetime || revoking.has(claims.sub) || !state.clients.some(client => client.client_id === claims.sub) || state.revoked.some(item => item.exp > seconds() && item.hash === digest(token).toString('hex'))) throw new Error();
      return { token, clientId: claims.sub, scopes: [scope], expiresAt: claims.exp, resource: new URL(resource) };
    } catch { throw new InvalidTokenError('Invalid access token'); }
  };
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: id => { prune(); return revoking.has(id) ? undefined : state.clients.find(client => client.client_id === id) ?? registrations.get(id)?.client; },
      registerClient: async metadata => {
        if (metadata.token_endpoint_auth_method !== 'none' || metadata.client_secret || (metadata.grant_types && (metadata.grant_types.length !== 1 || metadata.grant_types[0] !== 'authorization_code')) || (metadata.response_types && (metadata.response_types.length !== 1 || metadata.response_types[0] !== 'code')) || (metadata.scope && metadata.scope !== scope)) throw new InvalidClientMetadataError('Unsupported client metadata');
        const client = clientSchema.safeParse({ client_id: randomUUID(), client_id_issued_at: seconds(), client_name: metadata.client_name, redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope });
        if (!client.success) throw new InvalidClientMetadataError('Unsupported client metadata');
        prune(); if (registrations.size >= 64) throw new ServerError('Temporary client capacity reached');
        registrations.set(client.data.client_id, { client: client.data, expiresAt: seconds() + 300 }); return client.data;
      },
    },
    authorize: async (client, params, res) => {
      prune();
      if (revoking.has(client.client_id)) throw new InvalidRequestError('Client revocation in progress');
      if (params.scopes?.some(value => value !== scope)) throw new InvalidScopeError('Unsupported scope');
      if (params.resource && params.resource.href !== resource) throw new InvalidTargetError('Unsupported resource');
      if (!validRedirect(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048) throw new InvalidRequestError('Invalid authorization request');
      if (pending.size >= 32) throw new ServerError('Authorization capacity reached');
      const id = randomBytes(16).toString('hex'), nonce = randomBytes(32).toString('hex');
      pending.set(id, { id, nonce, clientId: client.client_id, clientName: client.client_name, params, expiresAt: seconds() + 300 });
      const scriptNonce = randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Approve coding agent connector</title><h1>Local owner approval required</h1><p>Client name (unverified): ${escape(client.client_name ?? 'Unnamed client')}</p><p>Client ID: ${escape(client.client_id)}</p><p>Exact callback: ${escape(params.redirectUri)}</p><p>This connector requests permission to supervise coding agents on this computer. In the local bridge CLI, inspect pending approvals and approve this client only if you initiated this connection. Never paste a bridge credential into chat.</p><p id="status">Waiting for local approval. This request expires after five minutes.</p><script nonce="${scriptNonce}">const end=Date.now()+300000;async function poll(){if(Date.now()>end){document.getElementById('status').textContent='Request expired. Restart connector enrollment.';return;}try{const r=await fetch('/authorization/status?id=${id}&nonce=${nonce}',{credentials:'omit',cache:'no-store'});if(!r.ok){document.getElementById('status').textContent='Request expired. Restart connector enrollment.';return;}const v=await r.json();if(v.redirect){location.replace(v.redirect);return;}}catch{}setTimeout(poll,1000);}poll();</script>`);
    },
    challengeForAuthorizationCode: async (client, code) => { prune(); const item = codes.get(code); if (!item || item.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code'); return item.challenge; },
    exchangeAuthorizationCode: async (client, code, _verifier, redirectUri, requestedResource) => {
      prune(); const item = codes.get(code);
      if (!item || item.clientId !== client.client_id || redirectUri !== item.redirectUri || (requestedResource && requestedResource.href !== resource)) throw new InvalidGrantError('Invalid authorization code');
      codes.delete(code);
      const issuedAt = seconds(), body = Buffer.from(JSON.stringify({ v: 1, jti: randomBytes(32).toString('hex'), sub: client.client_id, aud: resource, scope, iat: issuedAt, exp: issuedAt + lifetime })).toString('base64url');
      const token = `${body}.${createHmac('sha256', options.secret).update(body).digest('base64url')}`;
      return { access_token: token, token_type: 'Bearer', expires_in: lifetime, scope };
    },
    exchangeRefreshToken: async () => { throw new UnsupportedGrantTypeError('Refresh tokens are not supported'); },
    verifyAccessToken: verify,
    revokeToken: async (client, request) => {
      let info: AuthInfo; try { info = await verify(request.token); } catch { return; }
      if (info.clientId !== client.client_id) return;
      await update(next => { if (next.revoked.length >= 256) throw new ServerError('Revocation capacity reached'); next.revoked.push({ hash: digest(request.token).toString('hex'), exp: info.expiresAt! }); });
    },
  };
  const router = express.Router();
  const usedOwnerNonces = new Set<string>();
  const observations: OAuthObservation[] = [];
  router.use((req, res, next) => {
    const requestedPath = req.originalUrl.split('?')[0];
    const path = observedPaths.has(requestedPath) ? requestedPath : 'other';
    const method = observedEnum(req.method, ['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PUT', 'PATCH']);
    res.once('finish', () => {
      observations.push({ method, path, status: res.statusCode, ...(path === '/register' && method === 'POST' ? { registration: res.locals.remoteRegistrationObservation ?? registrationObservation(req.body) } : {}) });
      if (observations.length > 32) observations.splice(0, observations.length - 32);
    });
    next();
  });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use((_req, res, next) => {
    const json = res.json.bind(res);
    // Preserve machine-readable OAuth codes without exposing validation inputs.
    res.json = value => json(res.statusCode >= 400 && value && typeof value === 'object' && typeof value.error === 'string' ? { error: value.error, error_description: 'OAuth request rejected' } : value);
    next();
  });
  // The SDK advertises refresh/client-secret grants by default; expose our actual contract.
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: origin.href, authorization_endpoint: `${origin.origin}/authorize`, token_endpoint: `${origin.origin}/token`, registration_endpoint: `${origin.origin}/register`, revocation_endpoint: `${origin.origin}/revoke`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code'], scopes_supported: [scope] }));
  router.get('/authorization/status', (req, res) => {
    prune(); const id = req.query.id, nonce = req.query.nonce;
    const item = typeof id === 'string' ? pending.get(id) : undefined;
    if (!item || typeof nonce !== 'string' || !equal(item.nonce, nonce)) { res.status(404).json({ error: 'Unknown authorization' }); return; }
    res.json(item.redirect ? { state: 'approved', redirect: item.redirect } : { state: 'pending' });
  });
  router.use('/owner', express.json({ limit: '1kb' }), (req, res, next) => {
    const localHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== localHost || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || (req.headers.origin !== undefined && req.headers.origin !== `http://${localHost}`) || !verifyOwnerRequest(options.secret, { method: req.method, path: req.originalUrl, body: req.body, headers: req.headers }, usedOwnerNonces)) { res.status(403).json({ error: 'Local owner authorization required' }); return; }
    next();
  });
  router.get('/owner/pending', (_req, res) => { prune(); res.json([...pending.values()].filter(item => !item.redirect).map(item => ({ id: item.id, clientId: item.clientId, clientName: item.clientName, redirectUri: item.params.redirectUri, expiresAt: item.expiresAt, scopes: [scope] }))); });
  router.get('/owner/diagnostics', (_req, res) => res.json({ observations }));
  router.get('/owner/clients', (_req, res) => res.json(state.clients.map(client => ({ clientId: client.client_id, clientName: client.client_name, redirectUris: client.redirect_uris, issuedAt: client.client_id_issued_at, scopes: [scope] }))));
  router.post('/owner/revoke-client', express.json({ limit: '1kb' }), async (req, res) => {
    const clientId = req.body?.clientId;
    if (typeof clientId !== 'string' || !z.string().uuid().safeParse(clientId).success || !state.clients.some(client => client.client_id === clientId)) { res.status(404).json({ error: 'Unknown approved client' }); return; }
    revoking.add(clientId);
    // Invalidate outstanding authorization before the persistence await. Queued
    // approvals must never republish a captured pre-revocation client record.
    for (const [id, item] of pending) if (item.clientId === clientId) pending.delete(id);
    try { await update(next => { next.clients = next.clients.filter(client => client.client_id !== clientId); }); }
    catch { revoking.delete(clientId); res.status(500).json({ error: 'Client revocation failed' }); return; }
    registrations.delete(clientId);
    for (const [id, item] of pending) if (item.clientId === clientId) pending.delete(id);
    for (const [id, item] of codes) if (item.clientId === clientId) codes.delete(id);
    revoking.delete(clientId);
    res.json({ revoked: true, clientId });
  });
  router.post('/owner/approve', express.json({ limit: '1kb' }), async (req, res) => {
    prune(); const item = typeof req.body?.id === 'string' ? pending.get(req.body.id) : undefined;
    if (!item || item.redirect || item.approving || revoking.has(item.clientId)) { res.status(404).json({ error: 'Unknown pending authorization' }); return; }
    if (codes.size >= 32) { res.status(429).json({ error: 'Authorization capacity reached' }); return; }
    const registered = state.clients.find(client => client.client_id === item.clientId) ?? registrations.get(item.clientId)?.client;
    if (!registered) { res.status(404).json({ error: 'Unknown pending client' }); return; }
    item.approving = true;
    try { await update(next => {
      if (pending.get(item.id) !== item || item.expiresAt <= seconds() || revoking.has(item.clientId)) throw new ServerError('Authorization no longer pending');
      if (next.clients.some(client => client.client_id === item.clientId)) return;
      if (next.clients.length >= 64) throw new ServerError('Approved client capacity reached'); next.clients.push(registered);
    }); }
    catch { item.approving = false; res.status(500).json({ error: 'Client approval failed' }); return; }
    if (pending.get(item.id) !== item || item.expiresAt <= seconds() || revoking.has(item.clientId)) { res.status(409).json({ error: 'Authorization no longer pending' }); return; }
    registrations.delete(item.clientId);
    const code = randomBytes(32).toString('hex');
    codes.set(code, { clientId: item.clientId, redirectUri: item.params.redirectUri, challenge: item.params.codeChallenge, expiresAt: seconds() + 60 });
    const redirect = new URL(item.params.redirectUri); redirect.searchParams.set('code', code); if (item.params.state !== undefined) redirect.searchParams.set('state', item.params.state); redirect.searchParams.set('iss', origin.href); item.redirect = redirect.href;
    res.json({ approved: true, clientId: item.clientId });
  });
  // Validate the raw strings before the SDK URL schema canonicalizes them.
  router.post('/register', express.json({ limit: '16kb' }), (req, res, next) => {
    // Snapshot only allowlisted facts before RFC 7591 supported-metadata negotiation.
    res.locals.remoteRegistrationObservation = registrationObservation(req.body);
    const redirects: unknown = req.body?.redirect_uris;
    if (!Array.isArray(redirects) || redirects.some(value => typeof value !== 'string' || !validRedirect(value))) { res.status(400).json({ error: 'invalid_client_metadata' }); return; }
    // Registration advertises requested preferences; return the actual supported
    // public-client contract. Authorization still requires S256 and local consent.
    req.body = { ...req.body, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope };
    delete req.body.client_secret; delete req.body.client_secret_expires_at;
    next();
  });
  router.use(mcpAuthRouter({ provider, issuerUrl: origin, resourceServerUrl: new URL(resource), scopesSupported: [scope], resourceName: 'Local coding agent bridge' }));
  return { router, verify };
}
