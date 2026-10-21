import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { discoverOAuthServerInfo, exchangeAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { connectEndpoint, sameOriginFetch } from './security.js';
import { credentialReference, FileConnectCredentialStore, type ConnectCredentialStore } from './store.js';

export interface ConnectStatus {
  endpoint: string;
  credentialRef: string;
  state: 'not_enrolled' | 'ready' | 'reauthorization_required';
  expiresAt?: number;
}
export async function connectStatus(options: { endpoint: string; credentialRef?: string; store?: ConnectCredentialStore }): Promise<ConnectStatus> {
  const endpoint = connectEndpoint(options.endpoint).href;
  const ref = credentialReference(endpoint);
  if (options.credentialRef && options.credentialRef !== ref) throw new Error('Connect credential endpoint mismatch');
  const record = await (options.store ?? new FileConnectCredentialStore()).read(ref);
  if (record && record.endpoint !== endpoint) throw new Error('Connect credential endpoint mismatch');
  return { endpoint, credentialRef: ref, state: !record ? 'not_enrolled' : record.rejected || record.expiresAt <= Date.now() ? 'reauthorization_required' : 'ready', ...(record ? { expiresAt: record.expiresAt } : {}) };
}
export interface EnrollConnectOptions {
  endpoint: string;
  openBrowser: (url: URL) => Promise<void>;
  store?: ConnectCredentialStore;
  timeoutMs?: number;
}
/** Explicit enrollment only. Transport never silently launches a browser or refreshes a token. */
export async function enrollConnect(options: EnrollConnectOptions): Promise<ConnectStatus> {
  const endpoint = connectEndpoint(options.endpoint);
  const timeout = options.timeoutMs ?? 300000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) throw new Error('Connect enrollment timeout must be between 1 and 600000 milliseconds');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const state = randomBytes(32).toString('base64url');
  let issuer = endpoint.origin;
  let redirect: URL | undefined;
  let settled = false;
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Observe early timeouts even while SDK discovery or browser launching is still running.
  void code.catch(() => {});
  const aborted = () => rejectCode(new Error('Connect enrollment timed out; approval was not saved'));
  controller.signal.addEventListener('abort', aborted, { once: true });
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const fail = () => { res.statusCode = 400; res.end('Invalid Connect callback'); };
    if (!redirect || settled || req.method !== 'GET' || req.headers.host !== redirect.host || !req.url?.startsWith('/')) return fail();
    let url: URL;
    try { url = new URL(req.url, redirect); } catch { return fail(); }
    const returnedState = url.searchParams.get('state') ?? '';
    const left = Buffer.from(state), right = Buffer.from(returnedState);
    const one = (key: string) => url.searchParams.getAll(key).length === 1;
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || !one('state') || left.length !== right.length || !timingSafeEqual(left, right) ||
      !one('iss') || url.searchParams.get('iss') !== issuer) return fail();
    if (url.searchParams.has('error')) {
      settled = true; rejectCode(new Error('Connect approval was denied')); res.statusCode = 400; res.end('Connect approval denied'); return;
    }
    const value = url.searchParams.get('code');
    if (!one('code') || !value || value.length > 16384) return fail();
    settled = true; resolveCode(value); res.end('Connect approval received. You may close this window.');
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    redirect = new URL(`http://127.0.0.1:${address.port}/callback`);
    const fetchFn = sameOriginFetch(endpoint, controller.signal);
    const discovered = await discoverOAuthServerInfo(endpoint, { fetchFn });
    const metadata = discovered.authorizationServerMetadata;
    if (!metadata || discovered.authorizationServerUrl !== endpoint.origin || metadata.issuer !== endpoint.origin ||
      !metadata.registration_endpoint || !metadata.code_challenge_methods_supported?.includes('S256') ||
      !metadata.token_endpoint_auth_methods_supported?.includes('none') ||
      !metadata.grant_types_supported?.includes('authorization_code') ||
      discovered.resourceMetadata?.resource !== endpoint.href) throw new Error();
    // Validate metadata before registration or opening the browser; no cross-origin issuers/endpoints.
    for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
      const url = new URL(value);
      if (url.origin !== endpoint.origin || url.protocol !== 'https:' || url.username || url.password || value.includes('#')) throw new Error();
    }
    issuer = metadata.issuer;
    const scope = 'orchestration:read orchestration:operate';
    const clientInformation = await registerClient(issuer, { metadata, fetchFn, scope, clientMetadata: {
      client_name: 'Grok Agent Bridge', redirect_uris: [redirect.href], grant_types: ['authorization_code'],
      response_types: ['code'], token_endpoint_auth_method: 'none'
    } });
    if (clientInformation.token_endpoint_auth_method !== 'none' || clientInformation.client_secret) throw new Error();
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata, clientInformation, redirectUrl: redirect, scope, state, resource: endpoint });
    await Promise.race([options.openBrowser(authorizationUrl), code.then(() => undefined)]);
    const authorizationCode = await code;
    const tokens = await exchangeAuthorization(issuer, { metadata, clientInformation, authorizationCode, codeVerifier, redirectUri: redirect, resource: endpoint, fetchFn });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || !tokens.expires_in || tokens.expires_in <= 0 || !Number.isFinite(tokens.expires_in)) throw new Error();
    // T3 does not issue refresh tokens. Do not persist one if a server unexpectedly returns it.
    const now = Date.now(), expiresAt = now + tokens.expires_in * 1000;
    if (controller.signal.aborted || !Number.isFinite(expiresAt)) throw new Error();
    const ref = credentialReference(endpoint.href);
    await (options.store ?? new FileConnectCredentialStore()).write(ref, {
      version: 1, endpoint: endpoint.href, accessToken: tokens.access_token, expiresAt, enrolledAt: now,
      clientInformation: { client_id: clientInformation.client_id, issuer, token_endpoint_auth_method: 'none' }
    });
    return { endpoint: endpoint.href, credentialRef: ref, state: 'ready', expiresAt };
  } catch {
    throw new Error(controller.signal.aborted ? 'Connect enrollment timed out; approval was not saved' : 'Connect enrollment failed or approval was denied; no credential was saved');
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
    controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
