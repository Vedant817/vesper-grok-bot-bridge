import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteOAuth } from '../src/remote/oauth.js';
import { signOwnerRequest } from '../src/remote/owner-auth.js';

// Fixtures assert individual response fields below rather than trusting a cast to a protocol type.
const fetch = globalThis.fetch as (...args: Parameters<typeof globalThis.fetch>) => Promise<Omit<Response, 'json'> & { json(): Promise<any> }>;

const origin = 'https://bridge.example.test', secret = 'a'.repeat(64), verifier = 'v'.repeat(64), redirectUri = 'https://client.example.test/callback';
let home: string, server: Server, base: string, oauth: Awaited<ReturnType<typeof createRemoteOAuth>>;
async function boot() {
  oauth = await createRemoteOAuth({ origin, secret, home });
  const app = express(); app.use(oauth.router);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error(); base = `http://127.0.0.1:${address.port}`;
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'remote-oauth-')); await boot(); });
afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await rm(home, { recursive: true, force: true }); });
const post = (path: string, body: Record<string, string>) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
const owner = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...signOwnerRequest(secret, { method: body === undefined ? 'GET' : 'POST', path, body }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
const publicOwner = (path: string, body?: unknown): Promise<number> => new Promise((resolve, reject) => {
  const req = httpRequest(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: 'bridge.example.test', ...signOwnerRequest(secret, { method: body === undefined ? 'GET' : 'POST', path, body }), 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});
async function register(redirect = redirectUri, extra: Record<string, unknown> = {}) {
  return fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'My coding bot', redirect_uris: [redirect], token_endpoint_auth_method: 'none', ...extra }) });
}
async function request(clientId: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'owner-state', resource: origin + '/mcp', ...extra });
  return fetch(base + '/authorize?' + query, { redirect: 'manual' });
}
async function approved(clientId?: string) {
  const client = clientId ? { client_id: clientId } : await (await register()).json();
  const page = await request(client.client_id); expect(page.status).toBe(200);
  const html = await page.text(), path = html.match(/fetch\('([^']+)'/)! [1];
  const pending = await (await owner('/owner/pending')).json();
  expect(pending).toHaveLength(1);
  const approval = await owner('/owner/approve', { id: pending[0].id }); expect(approval.status).toBe(200);
  expect(await approval.json()).toEqual({ approved: true, clientId: client.client_id });
  const status = await (await fetch(base + path)).json(), callback = new URL(status.redirect);
  expect(callback.searchParams.get('state')).toBe('owner-state'); expect(callback.searchParams.get('iss')).toBe(origin + '/');
  return { clientId: client.client_id as string, code: callback.searchParams.get('code')!, path };
}
async function exchange(value: Awaited<ReturnType<typeof approved>>, extra: Record<string, string> = {}) {
  return post('/token', { grant_type: 'authorization_code', client_id: value.clientId, code: value.code, code_verifier: verifier, redirect_uri: redirectUri, resource: origin + '/mcp', ...extra });
}

it('publishes truthful no-refresh/public-client metadata and protected resource audience', async () => {
  const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  expect(metadata.grant_types_supported).toEqual(['authorization_code']); expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
  const resource = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json(); expect(resource.resource).toBe(origin + '/mcp');
});
it('real SDK DCR/PKCE handlers issue a bound token only after private local approval, and one code cannot replay', async () => {
  const value = await approved(), response = await exchange(value); expect(response.status).toBe(200);
  const tokens = await response.json(); expect(tokens.refresh_token).toBeUndefined(); expect(tokens.scope).toBe('coding:operate');
  const info = await oauth.verify(tokens.access_token); expect(info.clientId).toBe(value.clientId); expect(info.resource?.href).toBe(origin + '/mcp'); expect(info.scopes).toEqual(['coding:operate']);
  expect((await exchange(value)).status).toBe(400);
  const stored = await readFile(join(home, 'remote-oauth.json'), 'utf8'); expect(stored).not.toContain(secret); expect(stored).not.toContain(tokens.access_token); expect(stored).not.toContain(value.code);
});
it('rejects wrong PKCE, redirect, client and resource without permitting token issuance', async () => {
  const value = await approved(), other = await (await register()).json();
  const invalid: Record<string, string>[] = [{ code_verifier: 'wrong' }, { redirect_uri: redirectUri + '/other' }, { client_id: other.client_id }, { resource: 'https://other.test/mcp' }];
  for (const fields of invalid) expect((await exchange(value, fields)).status).toBe(400);
  expect((await exchange(value)).status).toBe(200);
});
it('refuses public Host owner approval even with the correct private credential', async () => {
  const client = await (await register()).json(); await request(client.client_id);
  expect(await publicOwner('/owner/pending')).toBe(403);
  expect((await fetch(base + '/owner/pending')).status).toBe(403);
  expect((await owner('/owner/pending', undefined, { Origin: origin })).status).toBe(403);
  const pending = await (await owner('/owner/pending')).json(); expect(pending[0].id).toMatch(/^[a-f0-9]{32}$/);
  expect(JSON.stringify(pending)).not.toMatch(/nonce|code_challenge|secret/);
  expect(await publicOwner('/owner/approve', { id: pending[0].id })).toBe(403);
});
it('rejects owner bearer credentials, replayed signatures and body tampering', async () => {
  expect((await fetch(base + '/owner/pending', { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(403);
  const headers = signOwnerRequest(secret, { method: 'GET', path: '/owner/pending' });
  expect(JSON.stringify(headers)).not.toContain(secret);
  expect((await fetch(base + '/owner/pending', { headers })).status).toBe(200);
  expect((await fetch(base + '/owner/pending', { headers })).status).toBe(403);
  const signed = signOwnerRequest(secret, { method: 'POST', path: '/owner/approve', body: { id: 'a'.repeat(32) } });
  expect((await fetch(base + '/owner/approve', { method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'b'.repeat(32) }) })).status).toBe(403);
});
it.each(['javascript:alert(1)', 'http://remote.example.test/callback', 'https://user:pass@client.test/callback', 'https://client.test/callback#fragment', 'https://client.test/callback#', ' https://client.test/callback'])('rejects unsafe callback %s', async redirect => { expect((await register(redirect)).status).toBe(400); });
it('permits native loopback callbacks but rejects unsupported auth/grants/scope', async () => {
  expect((await register('http://127.0.0.1:35411/callback')).status).toBe(201);
  for (const metadata of [{ token_endpoint_auth_method: 'client_secret_post' }, { grant_types: ['authorization_code', 'refresh_token'] }, { scope: 'coding:admin' }]) expect((await register(redirectUri, metadata)).status).toBe(400);
  const client = await (await register()).json(); expect((await request(client.client_id, { scope: 'coding:admin' })).status).toBe(302);
  expect(await (await owner('/owner/pending')).json()).toEqual([]);
});
it('escapes browser-visible client identity and never exposes pending state without its nonce', async () => {
  const client = await (await register(redirectUri, { client_name: '<script>alert(1)</script>' })).json();
  const page = await request(client.client_id), html = await page.text();
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const pending = await (await owner('/owner/pending')).json(); expect((await fetch(base + '/authorization/status?id=' + pending[0].id + '&nonce=wrong')).status).toBe(404);
});
it('retains clients and token verification across restart, persists revocation and does not support refresh', async () => {
  const value = await approved(), tokens = await (await exchange(value)).json();
  const restarted = await createRemoteOAuth({ origin, secret, home }); expect((await restarted.verify(tokens.access_token)).clientId).toBe(value.clientId);
  expect((await post('/token', { grant_type: 'refresh_token', client_id: value.clientId, refresh_token: 'anything' })).status).toBe(400);
  expect((await post('/revoke', { client_id: value.clientId, token: tokens.access_token })).status).toBe(200);
  await expect(oauth.verify(tokens.access_token)).rejects.toThrow('Invalid access token');
  const again = await createRemoteOAuth({ origin, secret, home }); await expect(again.verify(tokens.access_token)).rejects.toThrow('Invalid access token');
});
it('anonymous registration expires without consuming durable approved-client capacity', async () => {
  const client = await (await register()).json();
  expect(await (await owner('/owner/clients')).json()).toEqual([]);
  await expect(readFile(join(home, 'remote-oauth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const realNow = Date.now; vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 301000);
  expect((await request(client.client_id)).status).toBe(400);
  expect((await register()).status).toBe(201);
});
it('local owner can revoke an approved client and all its tokens durably, without public-host access', async () => {
  const value = await approved(), tokens = await (await exchange(value)).json();
  const clients = await (await owner('/owner/clients')).json(); expect(clients).toHaveLength(1); expect(clients[0].clientId).toBe(value.clientId);
  expect(JSON.stringify(clients)).not.toMatch(/access_token|nonce|secret/);
  expect(await publicOwner('/owner/clients')).toBe(403);
  expect(await publicOwner('/owner/revoke-client', { clientId: value.clientId })).toBe(403);
  const revoke = await owner('/owner/revoke-client', { clientId: value.clientId }); expect(await revoke.json()).toEqual({ revoked: true, clientId: value.clientId });
  await expect(oauth.verify(tokens.access_token)).rejects.toThrow('Invalid access token');
  expect(await (await owner('/owner/clients')).json()).toEqual([]);
  const restarted = await createRemoteOAuth({ origin, secret, home }); await expect(restarted.verify(tokens.access_token)).rejects.toThrow('Invalid access token');
  expect((await fetch(base + value.path)).status).toBe(404);
});
it('pending authorization is bounded and expires instead of granting permission on timeout', async () => {
  const client = await (await register()).json();
  for (let i = 0; i < 32; i++) expect((await request(client.client_id)).status).toBe(200);
  expect((await request(client.client_id)).status).toBe(302);
  const pending = await (await owner('/owner/pending')).json(); expect(pending).toHaveLength(32);
  const realNow = Date.now; vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 301000);
  expect(await (await owner('/owner/pending')).json()).toEqual([]);
  expect((await owner('/owner/approve', { id: pending[0].id })).status).toBe(404);
});
it('fails closed on tampered tokens, expired codes, expired tokens and malformed persistence', async () => {
  const value = await approved(), tokens = await (await exchange(value)).json();
  await expect(oauth.verify(tokens.access_token + 'x')).rejects.toThrow('Invalid access token');
  const realNow = Date.now; vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31 * 86400 * 1000);
  await expect(oauth.verify(tokens.access_token)).rejects.toThrow('Invalid access token'); vi.restoreAllMocks();
  const code = await approved(value.clientId); vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61000); expect((await exchange(code)).status).toBe(400); vi.restoreAllMocks();
  await writeFile(join(home, 'remote-oauth.json'), '{truncated'); await expect(createRemoteOAuth({ origin, secret, home })).rejects.toThrow('Invalid remote OAuth store');
});
