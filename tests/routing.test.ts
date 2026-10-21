import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeService } from '../src/bridge/service.js';
import { TaskRouter } from '../src/bridge/router.js';
import { git } from '../src/worktree.js';
import { AsyncQueue } from '../src/rpc.js';
import { createHash } from 'node:crypto';
import type { Worker, WorkerEvent } from '../src/contracts.js';
import type { Provider } from '../src/bridge/provider.js';

class TestWorker implements Worker {
  nativeSessionId = 'owned-native'; queue = new AsyncQueue<WorkerEvent>(); starts = 0; steers = 0; failSteer = false;
  async start() { this.starts++; }
  next(signal: AbortSignal) { return this.queue.next(signal); }
  async respond() {} async cancel() {} async close() { this.queue.close(); }
  async steer() { this.steers++; if (this.failSteer) throw new Error('Connection lost after send'); }
}
describe('task-aware durable dispatch', { timeout: 30000 }, () => {
  let base: string, directory: string, stateDirectory: string, bridge: BridgeService, router: TaskRouter, worker: TestWorker, provider: Provider;
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); expect(fn()).toBe(true); };
  const config = () => ({ stateDirectory, roots: [{ directory, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] });
  const input = () => ({ taskKey: 'fix-login', requestId: 'first', provider: 'test', model: 'exact', directory, instruction: 'Implement login' });
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dispatch-test-')); directory = join(base, 'repo'); stateDirectory = join(base, 'state'); await mkdir(directory);
    await git(directory, ['init']); await git(directory, ['config', 'user.name', 'Test']); await git(directory, ['config', 'user.email', 'test@example.test']);
    await writeFile(join(directory, 'source.txt'), 'fixture'); await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'fixture']);
    worker = new TestWorker(); provider = { id: 'test', label: 'Test', models: ['exact'], available: true, create: () => worker };
    bridge = await BridgeService.create(config(), [provider]); router = await TaskRouter.create(bridge, stateDirectory);
  });
  afterEach(async () => { await bridge?.close(); await rm(base, { recursive: true, force: true }); });
  it('starts once under concurrency and observes active work without sending follow-up', async () => {
    const [a, b] = await Promise.all([router.dispatch(input()), router.dispatch(input())]);
    expect(a.session.id).toBe(b.session.id); expect(worker.starts).toBe(1); expect(b.replayed).toBe(true);
    const active = await router.dispatch({ ...input(), requestId: 'active', instruction: 'Additional correction' });
    expect(active.action).toBe('observe'); expect(active.instructionSubmitted).toBe(false); expect(worker.steers).toBe(0);
    await expect(router.dispatch({ ...input(), instruction: 'changed' })).rejects.toThrow('different');
  });
  it('continues the exact completed worker and preserves durable receipts after restart', async () => {
    const initial = await router.dispatch(input()); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => bridge.read(initial.session.id).status === 'awaiting_review');
    const next = { ...input(), requestId: 'next', instruction: 'Fix edge case' };
    expect((await router.dispatch(next)).action).toBe('continue'); expect(worker.steers).toBe(1);
    await bridge.close(); worker = new TestWorker(); bridge = await BridgeService.create(config(), [provider]); router = await TaskRouter.create(bridge, stateDirectory);
    expect((await router.dispatch(next)).replayed).toBe(true); expect(worker.starts).toBe(0);
    const resumed = await router.dispatch({ ...input(), requestId: 'resume', instruction: 'Inspect restart state' });
    expect(resumed.session.id).toBe(initial.session.id); expect(worker.starts).toBe(1);
  });
  it('never replays a continuation whose acknowledgment was lost', async () => {
    const initial = await router.dispatch(input()); worker.queue.push({ type: 'completed', summary: 'Done' });
    await wait(() => bridge.read(initial.session.id).status === 'awaiting_review'); worker.failSteer = true;
    const next = { ...input(), requestId: 'uncertain', instruction: 'Fix it' };
    await expect(router.dispatch(next)).rejects.toThrow('Connection');
    await expect(router.dispatch(next)).rejects.toThrow('uncertain'); expect(worker.steers).toBe(1);
    await expect(router.dispatch({ ...next, requestId: 'new-id-bypass' })).rejects.toThrow('uncertain');
    router = await TaskRouter.create(bridge, stateDirectory);
    await expect(router.dispatch(next)).rejects.toThrow('uncertain'); expect(worker.steers).toBe(1);
  });
  it('requires explicit identity and exact scope, including model and native-session selection', async () => {
    await expect(router.dispatch({ ...input(), intent: 'continue' })).rejects.toThrow('No session');
    const a = await router.dispatch(input());
    await expect(router.dispatch({ ...input(), requestId: 'switch', model: 'fallback' })).rejects.toThrow('bound');
    await expect(router.dispatch({ ...input(), requestId: 'new', intent: 'new' })).rejects.toThrow('new taskKey');
    await expect(router.dispatch({ ...input(), taskKey: 'unrelated', requestId: 'hijack', sessionId: a.session.id })).rejects.toThrow('another task');
    await bridge.cancel(a.session.id);
    const terminal = await router.dispatch({ ...input(), requestId: 'terminal' });
    expect(terminal.instructionSubmitted).toBe(false); expect(terminal.session.status).toBe('cancelled'); expect(worker.starts).toBe(1);
  });
  it('reconciles a persisted start receipt without creating a duplicate', async () => {
    const original = await router.dispatch(input());
    const { readFile } = await import('node:fs/promises');
    const file = join(stateDirectory, 'routing.json'), state = JSON.parse(await readFile(file, 'utf8'));
    state.receipts[0].state = 'prepared'; delete state.receipts[0].sessionId; state.bindings = [];
    await writeFile(file, JSON.stringify(state)); router = await TaskRouter.create(bridge, stateDirectory);
    const recovered = await router.dispatch(input());
    expect(recovered.session.id).toBe(original.session.id); expect(worker.starts).toBe(1);
  });
  it('cannot bind an unrelated direct start through a colliding internal request ID', async () => {
    provider.models.push('other');
    const requestId = 'dispatch-' + createHash('sha256').update(input().requestId).digest('hex');
    await bridge.start({ provider: 'test', model: 'other', directory, task: 'Unrelated task', requestId });
    await expect(router.dispatch(input())).rejects.toThrow('different input');
    await expect(router.dispatch(input())).rejects.toThrow('does not match');
    await expect(router.dispatch({ ...input(), requestId: 'new-id' })).rejects.toThrow('uncertain'); expect(worker.starts).toBe(1);
  });
  it('blocks fresh IDs when a start was persisted but its task binding was lost', async () => {
    await router.dispatch(input());
    const { readFile } = await import('node:fs/promises');
    const file = join(stateDirectory, 'routing.json'), state = JSON.parse(await readFile(file, 'utf8'));
    state.receipts[0].state = 'prepared'; delete state.receipts[0].sessionId; state.bindings = [];
    await writeFile(file, JSON.stringify(state)); router = await TaskRouter.create(bridge, stateDirectory);
    await expect(router.dispatch({ ...input(), requestId: 'fresh' })).rejects.toThrow('uncertain'); expect(worker.starts).toBe(1);
  });
});
