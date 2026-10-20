import { it, expect } from 'vitest';
import { T3Worker } from '../src/adapters/t3.js';

it('pins the launched T3 provider/model and refuses a silently substituted selection', async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const worker = new T3Worker({
    async call(name, args): Promise<any> { calls.push({ name, args }); if (name === 't3_thread_launch') return { threadId: 'thread', status: 'starting', modelSelection: { instanceId: 'wrong', model: 'other' } }; return {}; },
    async close() {}
  }, 'project', 'task', { instanceId: 'codex', model: 'exact-model' });
  await expect(worker.start(process.cwd(), 'task')).rejects.toThrow('did not confirm');
  expect(calls[0].args.modelSelection).toEqual({ instanceId: 'codex', model: 'exact-model' });
  expect(calls.some(c => c.name === 't3_thread_interrupt')).toBe(true);
});

it('refuses to resume a T3 session whose native model differs from the owner import', async () => {
  const calls: string[] = [];
  const worker = new T3Worker({
    async call(name): Promise<any> { calls.push(name); return { thread: { worktreePath: process.cwd(), providerInstanceId: 'codex', model: 'other-model', projectId: 'project' } }; },
    async close() {}
  }, 'project', 'task', { instanceId: 'codex', model: 'exact-model', resumeId: 'native-thread' });
  await expect(worker.start(process.cwd(), 'task')).rejects.toThrow('provider, model or project');
  expect(calls).toEqual(['t3_thread_read']);
});

it('recognizes questions that arrive during a T3 wait instead of misclassifying runtime approval', async () => {
  let lists = 0;
  const worker = new T3Worker({
    async call(name): Promise<any> {
      if (name === 't3_thread_launch') return { threadId: 'thread', status: 'running' };
      if (name === 't3_thread_read') return { thread: { worktreePath: process.cwd(), pendingRequestCount: 1 } };
      if (name === 't3_pending_request_list') return { requestIds: ++lists === 1 ? [] : ['question'] };
      if (name === 't3_thread_wait') return { status: 'waiting' };
      if (name === 't3_pending_request_read') return { questions: [{ id: 'q', question: 'Choose?', options: [], allowCustomAnswer: true }] };
      throw new Error('Unexpected call');
    }, async close() {}
  }, 'project');
  await worker.start(process.cwd(), 'task');
  expect(await worker.next(AbortSignal.timeout(2000))).toMatchObject({ type: 'question', question: 'Choose?', allowCustomAnswer: true });
});
