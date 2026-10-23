import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPaths } from '../src/managed/paths.js';
import { ensureCredential, readCredential } from '../src/managed/credentials.js';

// Armed per test: simulate a filesystem without hard-link support and optionally a
// concurrent rotation publishing its credential first.
let failLink = false;
let concurrentPublish: string | undefined;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (!failLink) return actual.link(from, to);
      if (concurrentPublish !== undefined) await actual.writeFile(to, concurrentPublish, { flag: 'wx', mode: 0o600 });
      const failure = new Error('simulated hard-link failure') as NodeJS.ErrnoException;
      failure.code = 'EPERM';
      throw failure;
    },
  };
});
afterEach(() => { failLink = false; concurrentPublish = undefined; });

describe('managed credential publication races', { timeout: 60000 }, () => {
  it('still publishes by rename when hard links fail and no credential exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-credential-race-'));
    try {
      failLink = true;
      const paths = managedPaths(directory);
      const token = await ensureCredential(paths);
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(await readCredential(paths)).toBe(token);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps a concurrently published credential instead of overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-credential-race-'));
    try {
      const paths = managedPaths(directory);
      const winner = await ensureCredential(paths);
      const stored = await readFile(paths.token, 'utf8');
      await rename(paths.token, `${paths.token}.stash`);
      failLink = true;
      concurrentPublish = stored;
      const token = await ensureCredential(paths);
      expect(token).toBe(winner);
      expect(await readCredential(paths)).toBe(winner);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
