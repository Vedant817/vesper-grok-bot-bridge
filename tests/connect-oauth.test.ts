import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { enrollConnect, connectStatus } from '../src/connect/oauth.js';
import { credentialReference, type ConnectCredential, type ConnectCredentialStore } from '../src/connect/store.js';
import { connectEndpoint, sameOriginFetch } from '../src/connect/security.js';

const origin = 'https://connect.example', endpoint = `${origin}/mcp`;
const token = 'opaque-not-hex-☃-oauth-token';
const nativeFetch = globalThis.fetch;
class MemoryStore implements ConnectCredentialStore {
  records = new Map<string, ConnectCredential>();
  async read(ref: string) { return this.records.get(ref); }
  async write(ref: string, record: ConnectCredential) { this.records.set(ref, record); }
}
let server: Server, local: string, requests: { path: string; body: string; method?: string }[];
let metadataPatch: Record<string, unknown>, resourcePatch: Record<string, unknown>;
let authorization: URL | undefined;
let store: MemoryStore;
let redirectDiscovery: boolean;
beforeEach(async () => {
  requests = []; metadataPatch = {}; resourcePatch = {}; authorization = undefined; store = new MemoryStore(); redirectDiscovery = false;
  server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const path = req.url!; requests.push({ path, body, method: req.method });
    res.setHeader('Content-Type', 'application/json');
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (redirectDiscovery) { res.statusCode = 302; res.setHeader('Location', 'https://attacker.example/steal'); res.end(); return; }
    if (path.includes('oauth-protected-resource')) return json({ resource: endpoint, authorization_servers: [origin], ...resourcePatch });
    if (path.includes('oauth-authorization-server')) return json({ issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`,
      token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true, ...metadataPatch });
    if (path === '/oauth/mcp/register') { res.statusCode = 201; return json({ ...JSON.parse(body), client_id: 'public-client' }); }
    if (path === '/oauth/mcp/token') {
      const params = new URLSearchParams(body);
      const hash = createHash('sha256').update(params.get('code_verifier')!).digest('base64url');
      if (params.get('grant_type') !== 'authorization_code' || params.get('code') !== 'approved-code' || hash !== authorization?.searchParams.get('code_challenge') || params.get('redirect_uri') !== authorization?.searchParams.get('redirect_uri') || params.get('resource') !== endpoint) {
        res.statusCode = 400; return json({ error: 'invalid_grant' });
      }
      return json({ token_type: 'Bearer', access_token: token, expires_in: 2592000, refresh_token: 'must-not-persist' });
    }
    res.statusCode = 404; json({});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  local = `http://127.0.0.1:${address.port}`;
  // Production still validates HTTPS and origin before fetch. Only this fixture maps
  // that approved HTTPS origin onto a disposable local HTTP OAuth implementation.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new Error('Fixture observed an unapproved origin');
    return nativeFetch(local + url.pathname + url.search, init);
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function approve(url: URL, patch: Record<string, string> = {}) {
  authorization = url;
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  redirect.search = new URLSearchParams({ state: url.searchParams.get('state')!, iss: origin, code: 'approved-code', ...patch }).toString();
  return nativeFetch(redirect);
}
describe('public Connect enrollment', () => {
  it('uses real SDK DCR, authorization-code PKCE and loopback callback, persists only approved credentials', async () => {
    expect(await connectStatus({ endpoint, store })).toMatchObject({ state: 'not_enrolled' });
    const result = await enrollConnect({ endpoint, store, openBrowser: async url => { expect((await approve(url)).status).toBe(200); } });
    expect(result).toMatchObject({ state: 'ready', endpoint, credentialRef: credentialReference(endpoint) });
    expect(authorization!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization!.searchParams.get('scope')).toBe('orchestration:read orchestration:operate');
    expect(new URL(authorization!.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(store.records.size).toBe(1);
    const stored = store.records.get(result.credentialRef)!;
    expect(stored.accessToken).toBe(token);
    expect(JSON.stringify(stored)).not.toMatch(/must-not-persist|code_verifier|approved-code/);
    expect(JSON.stringify(result)).not.toContain(token);
    expect((await connectStatus({ endpoint, store })).state).toBe('ready');
    stored.expiresAt = Date.now() - 1;
    expect((await connectStatus({ endpoint, store })).state).toBe('reauthorization_required');
    expect(requests.filter(r => r.path.endsWith('/token'))).toHaveLength(1);
    expect(requests.every(r => !r.body.includes('refresh_token'))).toBe(true);
  });
  it('rejects hostile state, issuer, duplicate parameters and Host without consuming the valid callback', async () => {
    await enrollConnect({ endpoint, store, openBrowser: async url => {
      const patches: Record<string, string>[] = [{ state: 'wrong' }, { iss: 'https://attacker.example' }];
      for (const patch of patches) expect((await approve(url, patch)).status).toBe(400);
      const cb = new URL(url.searchParams.get('redirect_uri')!);
      cb.search = new URLSearchParams({ state: url.searchParams.get('state')!, iss: origin, code: 'approved-code' }).toString();
      expect((await nativeFetch(cb.href + '&state=duplicate')).status).toBe(400);
      expect((await nativeFetch(cb, { headers: { Host: 'attacker.example' } })).status).toBe(400);
      expect((await nativeFetch(cb, { method: 'POST' })).status).toBe(400);
      // Raw malformed request targets must return 400 rather than throw out of the handler.
      const malformed = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: cb.hostname, port: cb.port, path: '//[', headers: { Host: cb.host } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      expect(malformed).toBe(400);
      expect((await approve(url)).status).toBe(200);
    } });
    expect(store.records.size).toBe(1);
  });
  it.each([
    { authorization_endpoint: 'https://attacker.example/authorize' },
    { token_endpoint: 'http://127.0.0.1/token' },
    { registration_endpoint: 'https://user:pass@connect.example/register' },
    { issuer: 'https://attacker.example' },
    { code_challenge_methods_supported: ['plain'] },
    { token_endpoint_auth_methods_supported: ['client_secret_post'] }
  ])('rejects hostile or incompatible metadata before registration/browser: %j', async patch => {
    metadataPatch = patch; const openBrowser = vi.fn();
    await expect(enrollConnect({ endpoint, store, openBrowser })).rejects.toThrow('Connect enrollment failed');
    expect(openBrowser).not.toHaveBeenCalled(); expect(store.records.size).toBe(0);
    expect(requests.some(r => r.path.endsWith('/register'))).toBe(false);
  });
  it('rejects foreign resource metadata', async () => {
    resourcePatch = { resource: 'https://attacker.example/mcp' };
    await expect(enrollConnect({ endpoint, store, openBrowser: vi.fn() })).rejects.toThrow('Connect enrollment failed');
    expect(store.records.size).toBe(0);
  });
  it('refuses HTTP redirects during discovery and does not leak downstream failure bodies', async () => {
    redirectDiscovery = true;
    await expect(enrollConnect({ endpoint, store, openBrowser: vi.fn() })).rejects.toThrow('Connect enrollment failed');
    expect(store.records.size).toBe(0);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith(origin))).toBe(true);
  });
  it('times out even if browser launcher never returns and releases the callback listener', async () => {
    let callback: string | undefined;
    await expect(enrollConnect({ endpoint, store, timeoutMs: 150, openBrowser: async url => { callback = url.searchParams.get('redirect_uri')!; await new Promise(() => {}); } })).rejects.toThrow('timed out');
    expect(store.records.size).toBe(0);
    if (callback) await expect(nativeFetch(callback)).rejects.toThrow();
  });
  it('does not persist denied approval or echo OAuth error descriptions', async () => {
    await expect(enrollConnect({ endpoint, store, openBrowser: async url => {
      const cb = new URL(url.searchParams.get('redirect_uri')!);
      cb.search = new URLSearchParams({ state: url.searchParams.get('state')!, iss: origin, error: 'access_denied', error_description: token }).toString();
      await nativeFetch(cb);
    } })).rejects.toThrow('Connect enrollment failed');
    expect(store.records.size).toBe(0);
  });
});

it.each(['http://connect.example/mcp', 'https://u:p@connect.example/mcp', 'https://connect.example/mcp#', 'https://connect.example/mcp?token=secret', 'https://connect.example/', 'file:///mcp'])('rejects ambiguous endpoint %s', value => {
  expect(() => connectEndpoint(value)).toThrow('HTTPS /mcp');
});
it('checks origin before transmitting a bearer and refuses redirects', async () => {
  const safe = sameOriginFetch(new URL(endpoint));
  await expect(safe('https://attacker.example/token', { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow('approved HTTPS origin');
  expect(fetch).not.toHaveBeenCalled();
  await safe(`${origin}/mcp`, { method: 'GET' });
  expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe('error');
});
