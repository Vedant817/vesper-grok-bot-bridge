import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer } from 'node:http';
import { createRemoteOAuth } from '../src/remote/oauth.js';
import { serveRemote } from '../src/remote/http.js';
import { managedPaths } from '../src/managed/paths.js';
import { ensureCredential } from '../src/managed/credentials.js';
import { remoteCredentialPaths, saveRemoteConfig } from '../src/remote/config.js';
import { runManagedDaemon } from '../src/managed/runtime.js';
import { remoteCli } from '../src/remote-cli.js';
import { Redactor } from '../src/safety.js';
import { ownerMacKey } from '../src/remote/key-derivation.js';
import { signOwnerRequest } from '../src/remote/owner-auth.js';

const origin = 'https://qa.example.test', secret = 'b'.repeat(64), verifier = 'z'.repeat(64), redirect = 'https://client.example.test/callback';
const active: { close(): Promise<void> }[] = [], homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(active.splice(0).map(item => item.close())); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function boot(home?: string) {
  home ??= await mkdtemp(join(tmpdir(), 'remote-oauth-independent-')); if (!homes.includes(home)) homes.push(home);
  const oauth = await createRemoteOAuth({ origin, secret, home });
  const host = await serveRemote({ origin, token: secret, oauth, createServer: () => new Server({ name: 'qa', version: '1' }, { capabilities: {} }) }); active.push(host);
  const register = (metadata: Record<string, unknown> = {}) => fetch(host.url + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'QA', redirect_uris: [redirect], token_endpoint_auth_method: 'none', ...metadata }) });
  return { home, oauth, host, register };
}
async function token(context: Awaited<ReturnType<typeof boot>>, metadata: Record<string, unknown> = {}) {
  const client = await (await context.register(metadata)).json() as { client_id: string };
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: origin + '/mcp' });
  const html = await (await fetch(context.host.url + '/authorize?' + params)).text();
  const poll = html.match(/fetch\('([^']+)'/)![1];
  const pending = await (await owner(context, '/owner/pending')).json() as { id: string }[];
  await owner(context, '/owner/approve', { id: pending[0].id });
  const approved = await (await fetch(context.host.url + poll)).json() as { redirect: string };
  const code = new URL(approved.redirect).searchParams.get('code')!;
  const response = await fetch(context.host.url + '/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource: origin + '/mcp' }) });
  expect(response.status).toBe(200); return (await response.json() as { access_token: string }).access_token;
}
function owner(context: Awaited<ReturnType<typeof boot>>, path: string, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  return fetch(context.host.url + path, { method, headers: { ...signOwnerRequest(ownerMacKey(secret), { method, path, body }), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

it('completes locally approved PKCE after confidential-client negotiation and retains only original sanitized diagnostics', async () => {
  const context = await boot(), marker = 'QA_SECRET_STATE_MUST_NOT_BE_RETAINED';
  const issued = await token(context, { token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code', 'token'], scope: marker, client_secret: marker, client_name: marker });
  const info = await context.oauth.verify(issued);
  expect(info.scopes).toEqual(['coding:operate']);
  const diagnostics = await (await owner(context, '/owner/diagnostics')).json() as { observations: { registration?: { authMethod: string; grantTypes: string[]; scopePresent: boolean; scopeExpected: boolean; hasClientSecret: boolean } }[] };
  const registration = diagnostics.observations.find(item => item.registration)?.registration;
  expect(registration).toMatchObject({ authMethod: 'client_secret_post', grantTypes: ['authorization_code', 'refresh_token'], scopePresent: true, scopeExpected: false, hasClientSecret: true });
  expect(JSON.stringify(diagnostics)).not.toContain(marker);
  expect(JSON.stringify(diagnostics)).not.toContain(issued);
  expect(JSON.stringify(diagnostics)).not.toContain(secret);
});

it('does not permit another OAuth client to delete an existing MCP session', async () => {
  const context = await boot(), first = await token(context), second = await token(context);
  const headers = { Authorization: `Bearer ${first}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initialization = await fetch(context.host.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'client-a', version: '1' } } }) });
  expect(initialization.status).toBe(200); const sessionId = initialization.headers.get('mcp-session-id')!; await initialization.text();
  const stolen = await fetch(context.host.url + '/mcp', { method: 'DELETE', headers: { ...headers, Authorization: `Bearer ${second}`, 'mcp-session-id': sessionId } });
  expect(stolen.status).toBe(403);
});

it('does not permanently consume enrollment capacity through unapproved public registrations', async () => {
  let context = await boot();
  const issued = await token(context);
  const realNow = Date.now;
  for (let batch = 0; batch < 4; batch++) {
    for (let i = 0; i < 16; i++) expect((await context.register()).status).toBe(201);
    await context.host.close(); context = await boot(context.home);
  }
  const state = JSON.parse(await readFile(join(context.home, 'remote-oauth.json'), 'utf8'));
  expect(state.clients.length).toBe(1);
  expect((await context.oauth.verify(issued)).clientId).toBeTruthy();
  const temporary = await (await context.register()).json() as { client_id: string };
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 360000);
  const query = new URLSearchParams({ client_id: temporary.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  expect((await fetch(context.host.url + '/authorize?' + query, { redirect: 'manual' })).status).toBe(400);
  expect((await context.oauth.verify(issued)).clientId).toBeTruthy();
  const next = await context.register();
  expect(next.status).toBe(201);
}, 60000);

it('does not resurrect a revoked client through an overlapping approval', async () => {
  const context = await boot();
  for (let attempt = 0; attempt < 8; attempt++) {
    const issued = await token(context);
    const clientId = JSON.parse(Buffer.from(issued.split('.')[0]!, 'base64url').toString('utf8')).sub as string;
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    await fetch(context.host.url + '/authorize?' + query);
    const pending = await (await owner(context, '/owner/pending')).json() as { id: string }[];
    const revocation = owner(context, '/owner/revoke-client', { clientId });
    await new Promise(resolve => setTimeout(resolve, 0));
    const approval = owner(context, '/owner/approve', { id: pending[0]!.id });
    const [revoked] = await Promise.all([revocation, approval]);
    expect(revoked.status).toBe(200);
    const stillValid = await context.oauth.verify(issued).then(() => true, () => false);
    expect(stillValid).toBe(false);
  }
}, 60000);

it('never sends the private owner credential to a squatter when remote bind failed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-owner-squatter-')); homes.push(home);
  const paths = managedPaths(home); await ensureCredential(paths);
  const token = await ensureCredential(remoteCredentialPaths(paths));
  let disclosed = false;
  const squatter = createServer((request, response) => { disclosed ||= request.headers.authorization === `Bearer ${token}`; response.setHeader('Content-Type', 'application/json'); response.end('[]'); });
  await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve));
  active.push({ close: () => new Promise<void>(resolve => { squatter.closeAllConnections(); squatter.close(() => resolve()); }) });
  const address = squatter.address(); if (!address || typeof address === 'string') throw new Error('No squatter port');
  await saveRemoteConfig(paths, { origin, port: address.port });
  const daemon = await runManagedDaemon(paths, { repository: home, redactor: new Redactor() }); active.push(daemon);
  expect(JSON.parse(await readFile(join(home, 'remote-runtime.json'), 'utf8')).state).toBe('failed');
  await remoteCli(['remote', 'pending', '--home', home]).catch(() => {});
  expect(disclosed).toBe(false);
}, 60000);
