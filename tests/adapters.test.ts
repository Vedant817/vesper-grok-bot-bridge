import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AcpWorker } from '../src/adapters/acp.js';
import { CodexWorker } from '../src/adapters/codex.js';
import { T3Worker } from '../src/adapters/t3.js';
import { Rpc, AsyncQueue, StdioWire, childEnvironment, type Wire, type RpcMessage } from '../src/rpc.js';
import { GrokReasoner } from '../src/grok.js';
import { Redactor } from '../src/safety.js';
import { orderTasks } from '../src/task-graph.js';

class TestWire implements Wire {
  messages: RpcMessage[] = [];
  onMessage?: (m: RpcMessage) => void;
  onClose?: (e: Error) => void;
  constructor(private readonly reply: (m: RpcMessage) => unknown) {}
  send(m: RpcMessage): void { this.messages.push(m); if (m.method && m.id !== undefined) queueMicrotask(() => { const result = this.reply(m); if (result !== undefined) this.onMessage?.({ id: m.id, result }); }); }
  emit(m: RpcMessage): void { this.onMessage?.(m); }
  close(): void {}
}
const deadline = () => AbortSignal.timeout(2000);
describe('RPC lifecycle', () => {
  it('times out requests and rejects in-flight requests on disconnect', async () => {
    const wire = new TestWire(() => undefined), rpc = new Rpc(wire, 10);
    await expect(rpc.request('hang', {})).rejects.toThrow('timeout');
    const request = rpc.request('pending', {}); wire.onClose!(new Error('disconnected'));
    await expect(request).rejects.toThrow('disconnected'); rpc.close();
  });
  it('bounds queues and supports cancellation without consuming future events', async () => {
    const queue = new AsyncQueue<number>(1), abort = new AbortController();
    const pending = queue.next(abort.signal); abort.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop'); queue.push(1); expect(await queue.next(deadline())).toBe(1);
    queue.push(2); queue.push(3); await expect(queue.next(deadline())).rejects.toThrow('overflow');
  });
  it('does not inherit ambient API credentials', () => {
    process.env.GROK_TEST_SECRET = 'secret';
    expect(childEnvironment()).not.toHaveProperty('GROK_TEST_SECRET'); delete process.env.GROK_TEST_SECRET;
  });
});
describe('ACP', () => {
  it('converts malformed prompt results to failure events', async () => {
    const wire = new TestWire(m => m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: 's' } : null);
    const worker = new AcpWorker(async () => wire);
    try { await worker.start(process.cwd(), 'task'); expect(await worker.next(deadline())).toMatchObject({ type: 'failed', error: expect.stringContaining('Invalid ACP') }); }
    finally { await worker.close(); }
  });
  it('drives a real child process through initialize, permission denial and end_turn', async () => {
    const worker = new AcpWorker(async cwd => new StdioWire(process.execPath, [resolve('tests/fixtures/acp-agent.mjs')], cwd));
    try {
      await worker.start(process.cwd(), 'Inspect code');
      const event = await worker.next(deadline()); expect(event.type).toBe('permission');
      if (event.type !== 'permission') throw new Error('permission missing');
      await worker.respond(event.id, { allow: false });
      expect((await worker.next(deadline())).type).toBe('output'); expect((await worker.next(deadline())).type).toBe('completed');
      await expect(worker.respond(event.id, { allow: true })).rejects.toThrow('already answered');
    } finally { await worker.cancel(); await worker.close(); }
  });
  it('declines elicitation exactly once and rejects unknown methods', async () => {
    const wire = new TestWire(m => m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: 's' } : undefined);
    const worker = new AcpWorker(async () => wire);
    try {
      await worker.start(process.cwd(), 'task');
      wire.emit({ id: 88, method: 'elicitation/create', params: { sessionId: 's', mode: 'url', url: 'https://evil.invalid' } });
      expect(wire.messages.filter(m => m.id === 88)).toEqual([{ jsonrpc: '2.0', id: 88, result: { action: 'decline' } }]);
      wire.emit({ id: 89, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
      expect(wire.messages.find(m => m.id === 89)?.error?.code).toBe(-32601);
    } finally { await worker.close(); }
  });
});
describe('Codex app-server', () => {
  it('uses native framing, scopes events, answers questions and declines approvals', async () => {
    const wire = new TestWire(m => ({ initialize: {}, 'thread/start': { thread: { id: 't' } }, 'turn/start': { turn: { id: 'turn' } }, 'turn/interrupt': {} })[m.method!]);
    const worker = new CodexWorker(async () => wire);
    try {
      await worker.start(process.cwd(), 'task'); expect(wire.messages[0]).not.toHaveProperty('jsonrpc');
      wire.emit({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'other', command: 'ls' } });
      expect(wire.messages.at(-1)?.error).toBeDefined();
      wire.emit({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 't', command: 'rm -rf /', cwd: process.cwd() } });
      expect((await worker.next(deadline())).type).toBe('permission'); await worker.respond('2', { allow: false });
      expect(wire.messages.at(-1)?.result).toEqual({ decision: 'decline' });
      wire.emit({ id: 3, method: 'item/tool/requestUserInput', params: { threadId: 't', questions: [{ id: 'language', question: 'Language?', options: [{ label: 'TypeScript' }] }] } });
      expect((await worker.next(deadline())).type).toBe('question'); await worker.respond('3', { allow: false, answer: 'TypeScript' });
      expect(wire.messages.at(-1)?.result).toEqual({ answers: { language: { answers: ['TypeScript'] } } });
      wire.emit({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'stale', status: 'completed' } } });
      wire.emit({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
      expect((await worker.next(deadline())).type).toBe('completed');
    } finally { await worker.close(); }
  });
});
describe('T3 lifecycle contract', () => {
  it('launches with explicit workspace, reads question, sends answer and steers without duplicate launch', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []; let question = true;
    const worker = new T3Worker({ async call(name, args) {
      calls.push({ name, args });
      const values: Record<string, unknown> = {
        t3_thread_launch: { threadId: 't', status: 'running', runId: 'r' }, t3_thread_read: { thread: { worktreePath: process.cwd() }, items: [] },
        t3_pending_request_list: { requestIds: question ? ['q'] : [] },
        t3_pending_request_read: { questions: [{ id: 'lang', question: 'Language?', options: [{ label: 'TypeScript', value: 'ts' }] }] },
        t3_pending_request_respond: { sequence: 1 }, t3_thread_wait: { status: 'completed', runId: 'r' }, t3_thread_send: { runId: 'r2', status: 'running' }
      };
      if (name === 't3_pending_request_respond') question = false;
      return values[name] as any;
    }, close: async () => {} }, 'project');
    await worker.start(process.cwd(), 'task'); expect((calls[0].args.workspaceStrategy as any).type).toBe('existing_worktree');
    const q = await worker.next(deadline()); expect(q.type).toBe('question'); if (q.type !== 'question') throw new Error();
    await worker.respond(q.id, { allow: false, answer: 'TypeScript' });
    expect(calls.find(c => c.name === 't3_pending_request_respond')?.args.answers).toEqual({ lang: 'ts' });
    expect((await worker.next(deadline())).type).toBe('completed'); await worker.steer('repair');
    expect(calls.filter(c => c.name === 't3_thread_launch')).toHaveLength(1);
    expect(calls.at(-1)?.args).toMatchObject({ mode: 'auto', message: 'repair', threadId: 't' }); await worker.close();
  });
});
describe('Grok responses contract', () => {
  it('redacts outbound context, disables storage, parses strict answers', async () => {
    let request: any;
    const mockFetch: typeof fetch = async (_url, init) => { request = JSON.parse(init!.body as string); return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"TypeScript"}' }] }] }); };
    const grok = new GrokReasoner('secret', 'test-model', new Redactor(['secret']), mockFetch);
    expect(await grok.answer('Language?', 'secret', ['TypeScript'])).toBe('TypeScript');
    expect(request.store).toBe(false); expect(JSON.stringify(request)).not.toContain('secret');
    expect(Buffer.byteLength(request.input.map((i: any) => i.content).join(''))).toBeLessThanOrEqual(6000);
  });
  it('rejects malformed output, unoffered choices and provider errors', async () => {
    const grok = new GrokReasoner('key', 'model', undefined, async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"other"}' }] }] }));
    await expect(grok.answer('q', '', ['yes'])).rejects.toThrow('outside');
    const unavailable = new GrokReasoner('key', 'model', undefined, async () => new Response('secret', { status: 401 }));
    await expect(unavailable.answer('q', '')).rejects.toThrow('HTTP 401');
    expect(await grok.evaluate('goal', 'x'.repeat(6000))).toMatchObject({ accept: false });
  });
});
it('orders task DAGs and rejects cycles and missing dependencies before execution', () => {
  expect(orderTasks([{ id: 'b', goal: 'B', dependsOn: ['a'] }, { id: 'a', goal: 'A', dependsOn: [] }]).map(t => t.id)).toEqual(['a', 'b']);
  expect(() => orderTasks([{ id: 'a', goal: 'A', dependsOn: ['a'] }])).toThrow('cycle');
  expect(() => orderTasks([{ id: 'a', goal: 'A', dependsOn: ['missing'] }])).toThrow('Missing');
});
