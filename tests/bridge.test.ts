import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeService } from '../src/bridge/service.js';
import { createWorktree, git } from '../src/worktree.js';
import { AsyncQueue } from '../src/rpc.js';
import type { Worker, WorkerEvent } from '../src/contracts.js';
import { PendingRequestResolvedError } from '../src/contracts.js';
import { Redactor } from '../src/safety.js';
import type { Provider } from '../src/bridge/provider.js';

class TestWorker implements Worker {
  nativeSessionId = 'native-test'; queue = new AsyncQueue<WorkerEvent>(); replies: unknown[] = []; starts = 0;
  async start() { this.starts++; }
  next(signal: AbortSignal) { return this.queue.next(signal); }
  async respond(id: string, response: unknown) { this.replies.push({ id, response }); }
  async steer() {}
  async cancel() {}
  async close() { this.queue.close(); }
}
describe('portable session bridge', { timeout: 30000 }, () => {
  let base: string, repository: string, service: BridgeService, worker: TestWorker, provider: Provider;
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); expect(fn()).toBe(true); };
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'bridge-test-')); repository = join(base, 'repo'); await mkdir(repository);
    await git(repository, ['init']); await git(repository, ['config', 'user.name', 'Bridge Test']); await git(repository, ['config', 'user.email', 'bridge@example.test']);
    await writeFile(join(repository, 'source.txt'), 'original'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'fixture']);
    worker = new TestWorker(); provider = { id: 'test', label: 'Test', models: ['exact-model'], available: true, create: () => worker };
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] }, [provider]);
  });
  afterEach(async () => { await service?.close(); await rm(base, { recursive: true, force: true }); });
  const input = (repository: string) => ({ provider: 'test', model: 'exact-model', directory: repository, task: 'Implement goal', requestId: 'once' });
  it('redacts owner secrets in advertised ACP metadata before exposing discovery', async () => {
    await service.close();
    const secret = 'private-owner-credential-value-84321';
    provider.acp = { protocolVersion: 1, agentInfo: { name: secret }, capabilities: { loadSession: true }, authMethods: [], authentication: 'not_checked' };
    provider.protocol = 'acp';
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: [] } }] }, [provider], new Redactor([secret]));
    const catalog = service.discover();
    expect(catalog[0].protocol).toBe('acp');
    expect(catalog[0].acp?.authentication).toBe('not_checked');
    expect(JSON.stringify(catalog)).not.toContain(secret);
    expect(catalog[0].acp?.agentInfo?.name).toContain('[REDACTED]');
  });
  it('isolates work and deduplicates concurrent start IDs, rejects mismatches and model substitution', async () => {
    const [a, b] = await Promise.all([service.start(input(repository)), service.start(input(repository))]);
    expect(a.id).toBe(b.id); expect(worker.starts).toBe(1); expect(a.cwd).not.toBe(repository);
    await expect(service.start({ ...input(repository), task: 'different' })).rejects.toThrow('different input');
    await expect(service.start({ ...input(repository), requestId: 'other', model: 'fallback' })).rejects.toThrow('model');
    await expect(service.start({ ...input(repository), requestId: 'outside', directory: base })).rejects.toThrow('outside');
  });
  it('rejects another service owning the same state and canonicalizes directory symlinks', async () => {
    await expect(BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: [] } }] }, [provider])).rejects.toThrow('live owner');
    const outside = join(base, 'outside'); await mkdir(outside);
    const link = join(repository, 'escape'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.start({ ...input(repository), directory: link })).rejects.toThrow('outside');
  });
  it('does not accept failed owner checks', async () => {
    await service.close();
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(2)'] } }] }, [provider]);
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Trust me' });
    await wait(() => service.read(s.id).status === 'awaiting_review'); const evidence = await service.verify(s.id);
    expect(evidence.passed).toBe(false); await expect(service.finish(s.id, evidence.id)).rejects.toThrow('Passing');
  });
  it('cancels a running verifier without waiting behind its session lock', async () => {
    await service.close(); service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)'] } }] }, [provider]);
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Done' }); await wait(() => service.read(s.id).status === 'awaiting_review');
    const verification = service.verify(s.id).catch(error => error); await new Promise(r => setTimeout(r, 100));
    const started = Date.now(); await service.cancel(s.id); expect(Date.now() - started).toBeLessThan(5000); await verification; expect(service.read(s.id).status).toBe('cancelled');
  });
  it('awaits worker interruption before closing its transport', async () => {
    let closed = false, interrupted = false;
    worker.cancel = async () => { await new Promise(r => setTimeout(r, 20)); interrupted = !closed; };
    const originalClose = worker.close.bind(worker); worker.close = async () => { closed = true; await originalClose(); };
    const s = await service.start(input(repository)); await service.cancel(s.id); expect(interrupted).toBe(true); expect(closed).toBe(true);
  });
  it('preserves acknowledged cancellation when startup resolves later', async () => {
    let release!: () => void; const starting = new Promise<void>(resolve => { release = resolve; });
    worker.start = async () => { worker.starts++; await starting; };
    const pending = service.start(input(repository));
    await wait(() => worker.starts === 1); const session = service.list()[0];
    expect((await service.cancel(session.id)).status).toBe('cancelled'); release(); await pending;
    expect(service.read(session.id).status).toBe('cancelled'); expect(service.read(session.id).error).toBeUndefined();
  });
  it('redacts secrets split across output events', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'output', text: 'xai-' }); worker.queue.push({ type: 'output', text: 'abcdefgh12345678\n' }); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => service.read(s.id).status === 'awaiting_review');
    expect(JSON.stringify(service.read(s.id))).not.toContain('abcdefgh12345678'); expect(JSON.stringify(service.read(s.id))).toContain('REDACTED');
  });
  it('requires passing unchanged verification evidence before accepting a completed turn', async () => {
    const s = await service.start(input(repository));
    await expect(service.finish(s.id, 'invented')).rejects.toThrow('Passing');
    worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => service.read(s.id).status === 'awaiting_review');
    const evidence = await service.verify(s.id); expect(evidence.passed).toBe(true);
    await writeFile(join(s.cwd, 'source.txt'), 'changed after test');
    await expect(service.finish(s.id, evidence.id)).rejects.toThrow('changed');
    const updated = await service.verify(s.id); expect((await service.finish(s.id, updated.id)).status).toBe('finished');
    await new Promise(r => setTimeout(r, 30)); expect(service.read(s.id).status).toBe('finished');
  });
  it('rejects writes during shutdown and permits fresh verification only after confirmed stop', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => service.read(s.id).status === 'awaiting_review');
    const evidence = await service.verify(s.id);
    worker.cancel = async () => { await writeFile(join(s.cwd, 'source.txt'), 'late shutdown change'); };
    await expect(service.finish(s.id, evidence.id)).rejects.toThrow('during worker shutdown');
    expect(service.read(s.id).status).toBe('awaiting_review'); expect(service.read(s.id).evidence).toBeUndefined();
    const next = await service.verify(s.id); expect((await service.finish(s.id, next.id)).status).toBe('finished');
  });
  it('cannot accept unacknowledged shutdown by verifying again', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => service.read(s.id).status === 'awaiting_review'); const evidence = await service.verify(s.id);
    worker.cancel = async () => { throw new Error('not acknowledged'); };
    await expect(service.finish(s.id, evidence.id)).rejects.toThrow('not acknowledged'); expect(service.read(s.id).status).toBe('failed');
    await expect(service.verify(s.id)).rejects.toThrow('completed turn'); await expect(service.finish(s.id, evidence.id)).rejects.toThrow('Passing');
    expect((await service.cancel(s.id)).status).toBe('failed'); expect(service.monitor()[0]).toMatchObject({ recoveryRequired: true });
    expect(service.monitor()[0].nextSuggestedAction).toContain('unknown');
    await service.close(); worker = new TestWorker();
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }], imports: [{ id: 'unsafe-import', provider: 'test', model: 'exact-model', nativeId: 'native-test', worktree: s.worktree }] }, [provider]);
    await expect(service.attach('unsafe-import', 'Bypass ownership', 'unsafe')).rejects.toThrow('already managed'); expect(worker.starts).toBe(0);
  });
  it('keeps questions pending until a valid option and prevents blocked permission overrides', async () => {
    const s = await service.start(input(repository));
    worker.queue.push({ type: 'question', id: 'q1', question: 'Which?', options: ['one', 'two'] });
    await wait(() => service.read(s.id).pending.length === 1);
    await expect(service.respond(s.id, 'q1', { answer: 'three' })).rejects.toThrow('option');
    await service.respond(s.id, 'q1', { answer: 'one' }); expect(service.read(s.id).status).toBe('running');
    worker.queue.push({ type: 'permission', id: 'p1', request: { command: 'rm -rf /', cwd: s.cwd } });
    await wait(() => service.read(s.id).pending.length === 1);
    await expect(service.respond(s.id, 'p1', { allow: true })).rejects.toThrow('Blocked');
    await service.respond(s.id, 'p1', { allow: false }); expect(worker.replies).toHaveLength(2);
  });
  it('keeps the worker healthy when a request is withdrawn immediately before response', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'question', id: 'withdrawn', question: 'Which file?' });
    await wait(() => service.read(s.id).pending.length === 1);
    worker.respond = async () => { throw new PendingRequestResolvedError('withdrawn'); };
    const result = await service.respond(s.id, 'withdrawn', { answer: 'source.txt' });
    expect(result).toMatchObject({ responseSubmitted: false, requestResolved: true, status: 'running', pending: [] });
    worker.queue.push({ type: 'completed', summary: 'Done' }); await wait(() => service.read(s.id).status === 'awaiting_review');
  });
  it('recovers live sessions as interrupted and invalidates stale input', async () => {
    const s = await service.start(input(repository));
    worker.queue.push({ type: 'question', id: 'q', question: 'Choose' });
    await wait(() => service.read(s.id).pending.length === 1); await service.close();
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] }, [provider]);
    expect(service.read(s.id).status).toBe('interrupted'); expect(service.read(s.id).pending).toEqual([]);
    await expect(service.respond(s.id, 'q', { answer: 'yes' })).rejects.toThrow('pending');
  });
  it('resumes a completed disconnected native session with a new task', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Done' }); await wait(() => service.read(s.id).status === 'awaiting_review');
    await service.close(); worker = new TestWorker();
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] }, [provider]);
    expect((await service.resume(s.id, 'Fix the missing edge')).status).toBe('running'); expect(worker.starts).toBe(1);
  });
  it('imports only an explicitly enrolled linked worktree/native session', async () => {
    await service.close(); const linked = await createWorktree(repository, join(base, 'external-worktrees'));
    service = await BridgeService.create({ stateDirectory: join(base, 'state'), roots: [{ directory: repository, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }], imports: [{ id: 'existing', provider: 'test', model: 'exact-model', nativeId: 'native-test', worktree: linked }, { id: 'alias', provider: 'test', model: 'exact-model', nativeId: 'native-test', worktree: linked }] }, [provider]);
    await expect(service.attach('unknown', 'Review it', 'unknown')).rejects.toThrow('enrolled');
    const s = await service.attach('existing', 'Review it', 'existing'); expect(s.worktree).toBe(linked); expect(s.nativeId).toBe('native-test');
    await expect(service.attach('existing', 'Competing controller', 'other')).rejects.toThrow('already managed');
    await expect(service.attach('alias', 'Competing alias', 'other-alias')).rejects.toThrow('already managed');
  });
  it('invalidates old verification on follow-up and bounds identical prompts', async () => {
    const s = await service.start(input(repository)); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => service.read(s.id).status === 'awaiting_review'); await service.verify(s.id);
    await expect(service.followup(s.id, 'Implement goal')).rejects.toThrow('identical');
    await service.followup(s.id, 'Fix the omitted case'); expect(service.read(s.id).evidence).toBeUndefined(); expect(service.read(s.id).turns).toBe(2);
  });
});
