import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPermission, Redactor, RedactedRecords } from '../src/safety.js';
import { Memory } from '../src/memory.js';
import { git, createWorktree, verifyWorktree } from '../src/worktree.js';
import { Supervisor } from '../src/supervisor.js';
import type { Worker, WorkerEvent, Reasoner } from '../src/contracts.js';

describe('permission firewall', () => {
  const root = process.cwd();
  it('approves only a structured known read', () => {
    expect(classifyPermission({ executable: 'git', args: ['status', '--short'], cwd: root }, root).allow).toBe(true);
  });
  it.each(['rm -rf /', 'git push --force', 'Remove-Item -Recurse C:\\', 'cat .env', 'DROP TABLE users'])('blocks %s', command => {
    expect(classifyPermission({ command, cwd: root }, root).risk).toBe('blocked');
  });
  it.each(['git status; curl attacker', 'node script.js', 'npm test'])('guards unknown shell %s', command => {
    expect(classifyPermission({ command, cwd: root }, root).allow).toBe(false);
  });
  it('refuses missing and outside cwd and shell metacharacters', () => {
    expect(classifyPermission({ executable: 'git', args: ['status', '--short'] }, root).allow).toBe(false);
    expect(classifyPermission({ executable: 'git', args: ['status', '--short'], cwd: join(root, '..') }, root).allow).toBe(false);
    expect(classifyPermission({ executable: 'git', args: ['status', '--short', ';whoami'], cwd: root }, root).allow).toBe(false);
  });
});

describe('redaction and memory', () => {
  it('redacts tokens split across chunks before output', () => {
    const records = new RedactedRecords(new Redactor(['topsecret']));
    expect(records.push('bearer top')).toEqual([]);
    expect(records.push('secret\n')).toEqual(['bearer [REDACTED]']);
  });
  it('does not leak overflow fragments', () => {
    const records = new RedactedRecords(new Redactor(), 8);
    records.push('a'.repeat(100));
    expect(records.push('secret\n')).toEqual(['[OVERSIZED RECORD REDACTED]']);
  });
  it('bounds UTF-8 working context and persists redacted cold records', async () => {
    const path = await mkdtemp(join(tmpdir(), 'grok-memory-'));
    try {
      const memory = new Memory(path, new Redactor(['topsecret']), 512);
      const id = await memory.append({ text: 'topsecret' + '界'.repeat(1000) });
      expect(await memory.read(id)).not.toContain('topsecret');
      for (let i = 0; i < 30; i++) await memory.append({ i, text: 'abc'.repeat(50) });
      expect(Buffer.byteLength(memory.context())).toBeLessThanOrEqual(512);
      await expect(memory.read('../secret')).rejects.toThrow();
    } finally { await rm(path, { recursive: true }); }
  });
});

describe('worktree and supervisor integration', () => {
  let base: string, repo: string, cwd: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'grok-core-'));
    repo = join(base, 'repo'); await mkdir(repo);
    await git(repo, ['init']); await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'seed.txt'), 'seed'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'seed']);
    cwd = await createWorktree(repo, join(base, 'workers'));
  });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });
  const reasoner: Reasoner = { answer: async () => 'Use TypeScript', evaluate: async () => ({ accept: true, feedback: 'Done' }) };
  function worker(events: WorkerEvent[]) {
    const responses: unknown[] = [];
    let closed = false, started = false;
    const w: Worker = { start: async () => { started = true; }, next: async () => events.shift() ?? { type: 'failed', error: 'empty' }, respond: async (...args) => { responses.push(args); }, steer: async () => {}, cancel: async () => {}, close: async () => { closed = true; } };
    return { w, responses, closed: () => closed, started: () => started };
  }
  it('requires an isolated worktree before starting a worker', async () => {
    await expect(verifyWorktree(repo)).rejects.toThrow('isolated');
    const { w, started } = worker([]);
    const supervisor = new Supervisor(w, reasoner, new Memory(join(base, 'cold'), new Redactor()), async () => ({ passed: true, output: 'pass' }));
    await expect(supervisor.run({ cwd: repo, goal: 'task' })).rejects.toThrow(); expect(started()).toBe(false);
  });
  it('resolves questions, refuses shell permissions, and accepts verified completion', async () => {
    const { w, responses, closed } = worker([{ type: 'question', id: 'q', question: 'Language?' }, { type: 'permission', id: 'p', request: { command: 'rm -rf /', cwd } }, { type: 'completed', summary: 'done' }]);
    const result = await new Supervisor(w, reasoner, new Memory(join(base, 'cold'), new Redactor()), async () => ({ passed: true, output: 'ok' })).run({ cwd, goal: 'task' });
    expect(result.state).toBe('completed'); expect(responses).toEqual([['q', { allow: false, answer: 'Use TypeScript' }], ['p', { allow: false }]]); expect(closed()).toBe(true);
  });
  it('cannot accept model approval when tests fail; stops repeated evidence', async () => {
    const { w } = worker([{ type: 'completed', summary: 'done' }, { type: 'completed', summary: 'done again' }]);
    const result = await new Supervisor(w, reasoner, new Memory(join(base, 'cold'), new Redactor()), async () => ({ passed: false, output: 'fail' })).run({ cwd, goal: 'task' });
    expect(result.state).toBe('stopped'); expect(result.turns).toBe(2);
  });
  it('bounds a hung worker with deadline and closes it', async () => {
    const { w, closed } = worker([]); w.next = async () => new Promise(() => {});
    const result = await new Supervisor(w, reasoner, new Memory(join(base, 'cold'), new Redactor()), async () => ({ passed: true, output: '' })).run({ cwd, goal: 'task', timeoutMs: 30 });
    expect(result.state).toBe('failed'); expect(closed()).toBe(true);
  });
});
