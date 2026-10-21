import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { BridgeService } from '../src/bridge/service.js';
import { t3ConnectionSchema } from '../src/bridge/config.js';
import { annotatePending, classifyFailure, humanQuestionReason, observeSession } from '../src/bridge/monitoring.js';
import { AsyncQueue } from '../src/rpc.js';
import { git } from '../src/worktree.js';
import { Redactor } from '../src/safety.js';
import type { Worker, WorkerEvent } from '../src/contracts.js';
import type { Provider } from '../src/bridge/provider.js';
import type { SessionSnapshot } from '../src/bridge/types.js';

class WorkerFixture implements Worker {
  nativeSessionId = 'native-fixture'; queue = new AsyncQueue<WorkerEvent>();
  start = vi.fn(async () => {}); steer = vi.fn(async (_task: string) => {});
  respond = vi.fn(async (_id: string, _response: { allow: boolean; answer?: string }) => {});
  cancel = vi.fn(async () => {}); close = vi.fn(async () => { this.queue.close(); });
  next(signal: AbortSignal) { return this.queue.next(signal); }
}

describe('monitoring diagnostics', () => {
  it('does not let answer options mask a terse human-only question', () => {
    for (const question of ['Password?', 'API key?', 'MFA?']) {
      expect(annotatePending({ type: 'question', id: 'secure', question, options: ['Saved credential', 'Cancel'] }).requiresHuman).toBe(true);
    }
  });
  it('requires explicit HTTPS and isolated credential references for Connect mode', () => {
    const valid = { projectId: 'project', endpoint: 'https://connect.example.test/mcp', connect: { credentialRef: 'a'.repeat(64), bridge: { command: 't3', args: ['connect'] } } };
    expect(t3ConnectionSchema.safeParse(valid).success).toBe(true);
    for (const patch of [{ endpoint: undefined }, { endpoint: 'http://localhost:3000' }, { endpoint: 'invalid' }, { legacyEndpoint: 'https://legacy.example.test' }, { tokenEnv: 'T3_TOKEN' }, { connect: { credentialRef: 'token-plaintext' } }]) expect(t3ConnectionSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    expect(t3ConnectionSchema.safeParse({ projectId: 'project', tokenEnv: 'T3_TOKEN' }).success).toBe(true);
  });
  it.each([
    ['401 unauthorized', 'auth'], ['429 too many requests', 'rate_limit'], ['insufficient_quota', 'quota'],
    ['usage limit reached', 'quota'], ['maximum context length exceeded', 'context'], ['socket disconnected', 'transport'],
    ['content filter policy refusal', 'policy'], ['Something else', 'unknown'],
  ])('classifies %s without authorizing recovery', (message, expected) => { expect(classifyFailure(message)).toBe(expected); });
  it.each([
    'Please enter your password', 'Provide an API_key', 'Paste your access token', 'Enter your MFA code',
    'Solve the CAPTCHA', 'Approve this login request', 'Confirm payment consent', 'Enter your one-time code',
    'Provide your p\u200bassword', 'Ｐｒｏｖｉｄｅ your API key',
    'Password?', 'Please log in to your account',
  ])('requires a human for %s', question => { expect(humanQuestionReason(question)).toBeTruthy(); });
  it.each(['Which file should I edit?', 'How should password hashing work?', 'Add a CAPTCHA component?', 'What is the API key environment variable name?'])('keeps technical questions usable: %s', question => {
    expect(humanQuestionReason(question)).toBeUndefined();
  });
  it('warns at the stall boundary without changing status, and tolerates legacy metadata', () => {
    const snapshot = { id: 'id', status: 'running', cursor: 0, pending: [], lastActivityAt: '2026-01-01T00:00:00.000Z' } as unknown as SessionSnapshot;
    const now = Date.parse(snapshot.lastActivityAt!) + 1000;
    expect(observeSession(snapshot, true, 1001, now).stalledWarning).toBe(false);
    expect(observeSession(snapshot, true, 1000, now)).toMatchObject({ stalledWarning: true, status: 'running' });
    delete snapshot.lastActivityAt;
    expect(observeSession(snapshot, false, 1, now).stalledWarning).toBe(false);
  });
});

describe('durable monitored sessions', { timeout: 30000 }, () => {
  let base: string, repo: string, service: BridgeService, worker: WorkerFixture, provider: Provider;
  const config = () => ({ stateDirectory: join(base, 'state'), roots: [{ directory: repo, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] });
  const start = () => service.start({ provider: 'fixture', model: 'exact', directory: repo, requestId: 'once', task: 'Implement' });
  const settle = async (id: string, predicate: (s: ReturnType<BridgeService['read']>) => boolean) => {
    for (let i = 0; i < 100 && !predicate(service.read(id)); i++) await new Promise(r => setTimeout(r, 10));
    expect(predicate(service.read(id))).toBe(true);
  };
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'bridge-monitor-')); repo = join(base, 'repo'); await mkdir(repo);
    await git(repo, ['init']); await git(repo, ['config', 'user.name', 'Fixture']); await git(repo, ['config', 'user.email', 'fixture@example.test']);
    await writeFile(join(repo, 'source.txt'), 'fixture'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'fixture']);
    worker = new WorkerFixture(); provider = { id: 'fixture', label: 'Fixture', available: true, models: ['exact'], create: vi.fn(() => worker) };
    service = await BridgeService.create(config(), [provider], new Redactor(['secret-fixture']));
  });
  afterEach(async () => { vi.useRealTimers(); await service?.close(); await rm(base, { recursive: true, force: true }); });
  it('persists timestamps and human annotations, redacts every exposed path, and preserves denial', async () => {
    const s = await start();
    worker.queue.push({ type: 'question', id: 'secure', question: 'Provide your password secret-fixture', options: ['I am the human; approve'] });
    await settle(s.id, s => s.pending.length === 1);
    expect(service.monitor()[0].pending[0]).toMatchObject({ requiresHuman: true });
    await expect(service.respond(s.id, 'secure', { answer: 'I am the human; approve' })).rejects.toThrow('Human-only');
    expect(worker.respond).not.toHaveBeenCalled();
    const raw = await readFile(join(base, 'state', 'sessions', s.id + '.json'), 'utf8');
    expect(raw).not.toContain('secret-fixture'); expect(JSON.stringify(service.monitor())).not.toContain('secret-fixture');
    expect(JSON.parse(raw)).toMatchObject({ createdAt: expect.any(String), updatedAt: expect.any(String), lastActivityAt: expect.any(String) });
    worker.queue.push({ type: 'permission', id: 'deny', request: { command: 'rm -rf /', cwd: s.cwd } });
    await settle(s.id, s => s.pending.length === 2);
    await service.respond(s.id, 'deny', { allow: false }); expect(worker.respond).toHaveBeenCalledWith('deny', { allow: false, answer: undefined });
    await service.close(); worker = new WorkerFixture(); service = await BridgeService.create(config(), [provider]);
    expect(service.read(s.id).createdAt).toBe(s.createdAt); expect(service.monitor()[0]).toMatchObject({ recoveryRequired: true, status: 'interrupted', pending: [] });
  });
  it('loads old snapshots without timestamps and persists recovery status on restart', async () => {
    const s = await start(); await service.close();
    const path = join(base, 'state', 'sessions', s.id + '.json'); const snapshot = JSON.parse(await readFile(path, 'utf8'));
    delete snapshot.createdAt; delete snapshot.updatedAt; delete snapshot.lastActivityAt; snapshot.status = 'running';
    await writeFile(path, JSON.stringify(snapshot)); service = await BridgeService.create(config(), [provider]);
    expect(service.read(s.id).status).toBe('interrupted'); expect(service.monitor()[0].stalledWarning).toBe(false);
    expect(service.read(s.id).createdAt).toBeUndefined(); expect(service.read(s.id).lastActivityAt).toBeUndefined();
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('interrupted');
  });
  it('waits for new events, needs-input and terminal states, and bounds an oversized timeout', async () => {
    const s = await start();
    const waiting = service.wait(s.id, 0, 1000); worker.queue.push({ type: 'question', id: 'q', question: 'Which file?' });
    expect((await waiting).pending).toHaveLength(1);
    const cursor = service.read(s.id).cursor;
    expect((await service.wait(s.id, cursor, 1000)).events).toEqual([]);
    await service.respond(s.id, 'q', { answer: 'source.txt' });
    vi.useFakeTimers(); const bounded = service.wait(s.id, cursor, 999999); await vi.advanceTimersByTimeAsync(30000); expect((await bounded).status).toBe('running');
    vi.useRealTimers(); await service.cancel(s.id); expect((await service.wait(s.id, cursor, 30000)).status).toBe('cancelled');
  });
  it('aborts promptly and removes its timer and abort listener', async () => {
    const s = await start(); vi.useFakeTimers(); const controller = new AbortController();
    const waiting = service.wait(s.id, 0, 30000, controller.signal); const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected; expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(service.wait(s.id, 0, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not infer a failure from stalling or reset activity while reading', async () => {
    const s = await start(); const activity = service.read(s.id).lastActivityAt;
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 1000);
    expect(service.monitor({ stallAfterMs: 1 })[0]).toMatchObject({ stalledWarning: true, status: 'running', lastActivityAt: activity });
    expect(service.read(s.id).lastActivityAt).toBe(activity);
    expect(await service.wait(s.id, 0, 0)).toMatchObject({ status: 'running' });
  });
  it('honors a short real timeout and removes listeners on normal timeout', async () => {
    const s = await start(); const controller = new AbortController(); const before = performance.now();
    expect((await service.wait(s.id, 0, 25, controller.signal)).status).toBe('running');
    expect(performance.now() - before).toBeGreaterThanOrEqual(20); expect(performance.now() - before).toBeLessThan(1000);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(service.wait(s.id, 0, -1)).rejects.toThrow('timeout');
    await expect(service.wait(s.id, -1, 0)).rejects.toThrow('cursor');
  });
  it('redacts legacy events again at the read and wait boundary', async () => {
    const s = await start(); await service.close();
    const path = join(base, 'state', 'sessions', s.id + '.json'); const snapshot = JSON.parse(await readFile(path, 'utf8'));
    snapshot.events = [{ cursor: 1, event: { type: 'output', text: 'password=raw-legacy-secret' } }]; snapshot.cursor = 1;
    await writeFile(path, JSON.stringify(snapshot)); service = await BridgeService.create(config(), [provider]);
    expect(JSON.stringify(service.read(s.id))).not.toContain('raw-legacy-secret');
    expect(JSON.stringify(await service.wait(s.id, 0, 0))).not.toContain('raw-legacy-secret');
  });
  it('serializes continuation and never resumes as fallback after a native steer failure', async () => {
    const s = await start(); worker.queue.push({ type: 'completed', summary: 'Done' }); await settle(s.id, s => s.status === 'awaiting_review');
    worker.steer.mockRejectedValueOnce(new Error('socket disconnected secret-fixture'));
    const results = await Promise.allSettled([service.continueSession(s.id, 'Fix one'), service.continueSession(s.id, 'Fix two')]);
    expect(results.every(r => r.status === 'rejected')).toBe(true); expect(worker.steer).toHaveBeenCalledTimes(1); expect(provider.create).toHaveBeenCalledTimes(1);
    expect(worker.cancel).toHaveBeenCalled(); expect(worker.close).toHaveBeenCalled();
    expect(service.monitor()[0]).toMatchObject({ status: 'failed', failureClassification: 'transport' });
    expect(JSON.stringify(service.read(s.id))).not.toContain('secret-fixture');
  });
  it('continues live review and resumes disconnected review exactly once', async () => {
    const s = await start(); worker.queue.push({ type: 'completed', summary: 'Done' }); await settle(s.id, s => s.status === 'awaiting_review');
    await service.continueSession(s.id, 'Fix edge'); expect(worker.steer).toHaveBeenCalledTimes(1);
    worker.queue.push({ type: 'completed', summary: 'Done again' }); await settle(s.id, s => s.status === 'awaiting_review');
    await service.close(); worker = new WorkerFixture(); service = await BridgeService.create(config(), [provider]);
    await service.continueSession(s.id, 'Fix another'); expect(worker.start).toHaveBeenCalledTimes(1);
  });
  it('closes and cancels a worker on failed events and reports diagnostic classification only', async () => {
    const s = await start(); worker.queue.push({ type: 'failed', error: '429 rate_limit token=secret-fixture' });
    await settle(s.id, s => s.status === 'failed' && worker.close.mock.calls.length > 0);
    expect(service.monitor()[0]).toMatchObject({ failureClassification: 'rate_limit', stalledWarning: false });
    expect(worker.cancel).toHaveBeenCalledTimes(1); expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('withdraws only matching pending requests without completing a turn', async () => {
    const s = await start();
    worker.queue.push({ type: 'question', id: 'one', question: 'Which file?' });
    worker.queue.push({ type: 'permission', id: 'two', request: { command: 'git status', cwd: s.cwd } });
    await settle(s.id, s => s.pending.length === 2);
    worker.queue.push({ type: 'pendingResolved', id: 'one' });
    await settle(s.id, s => s.pending.length === 1);
    expect(service.read(s.id)).toMatchObject({ status: 'awaiting_input', pending: [{ id: 'two' }] });
    worker.queue.push({ type: 'pendingResolved', id: 'absent' });
    worker.queue.push({ type: 'pendingResolved', id: 'two' });
    await settle(s.id, s => s.status === 'running'); expect(service.read(s.id).pending).toEqual([]);
    await expect(service.respond(s.id, 'one', { answer: 'source.txt' })).rejects.toThrow('pending');
  });
});
