import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConnectCredentialStore, credentialReference, type ConnectCredential } from '../src/connect/store.js';

it('round-trips arbitrary OAuth records in a private per-user store, using real Windows DPAPI', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'grok-connect-store-'));
  try {
    const home = join(temporary, 'private-connect');
    const store = new FileConnectCredentialStore(home);
    const endpoint = 'https://connect.example/mcp', ref = credentialReference(endpoint);
    expect(await store.read(ref)).toBeUndefined();
    const record: ConnectCredential = { version: 1, endpoint, accessToken: 'arbitrary.OAuth-token/☃?+=',
      expiresAt: Date.now() + 100000, enrolledAt: Date.now(), clientInformation: { client_id: 'public-registration-☃', issuer: 'https://connect.example' } };
    await store.write(ref, record);
    const saved = await readFile(join(home, `${ref}.json.enc`), 'utf8');
    if (process.platform === 'win32') { expect(saved).toMatch(/^grok-connect-dpapi-v1\n/); expect(saved).not.toContain(record.accessToken); }
    expect(await store.read(ref)).toEqual(record);
    await store.write(ref, { ...record, rejected: true });
    expect(await store.read(ref)).toEqual({ ...record, rejected: true });
    await expect(store.read('../outside')).rejects.toThrow('reference');
    await expect(store.write(credentialReference('https://other.example/mcp'), record)).rejects.toThrow('endpoint mismatch');
    await writeFile(join(home, `${ref}.json.enc`), 'corrupt-secret-value');
    await expect(store.read(ref)).rejects.toThrow('Connect credential cannot be read');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30000);

it('refuses to repurpose or harden an unrelated nonempty directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'grok-connect-unowned-'));
  try {
    await writeFile(join(temporary, 'keep.txt'), 'unrelated');
    const store = new FileConnectCredentialStore(temporary), endpoint = 'https://connect.example/mcp';
    await expect(store.write(credentialReference(endpoint), { version: 1, endpoint, accessToken: 'secret',
      expiresAt: Date.now() + 1000, enrolledAt: Date.now(), clientInformation: {} })).rejects.toThrow('non-empty directory');
    expect(await readFile(join(temporary, 'keep.txt'), 'utf8')).toBe('unrelated');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
