import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpWorker } from '../src/adapters/acp.js';
import { CodexWorker } from '../src/adapters/codex.js';
import { ClaudeWorker } from '../src/adapters/claude.js';
import { Rpc, type RpcMessage, type Wire } from '../src/rpc.js';

class TestWire implements Wire {
  messages: any[] = [];
  closed = false;
  onMessage?: (message: RpcMessage) => void;
  onClose?: (error: Error) => void;
  constructor(private readonly reply: (message: any) => unknown = () => undefined) {}
  send(message: RpcMessage): void {
    this.messages.push(message);
    const result = this.reply(message);
    if (message.method && message.id !== undefined && result !== undefined) queueMicrotask(() => this.emit({ id: message.id, result }));
  }
  emit(message: unknown): void { this.onMessage?.(message as RpcMessage); }
  close(): void { this.closed = true; }
}
const signal = () => new AbortController().signal;
const acpWire = () => new TestWire(m => m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: 'session' } : undefined);
const codexWire = () => new TestWire(m => ({ initialize: {}, 'thread/start': { thread: { id: 'thread' } }, 'turn/start': { turn: { id: 'turn' } }, 'turn/interrupt': {} })[m.method as string]);
async function claude() {
  const wire = new TestWire(m => {
    if (m.type === 'control_request' && m.request.subtype === 'initialize') queueMicrotask(() => wire.emit({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success' } }));
  });
  const worker = new ClaudeWorker(async () => wire);
  await worker.start(process.cwd(), 'task');
  return { worker, wire };
}
const acpPermission = (id: number) => ({ id, method: 'session/request_permission', params: { sessionId: 'session', toolCall: { kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ kind: 'allow_once', optionId: 'allow' }] } });
const codexPermission = (id: number) => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'echo hi', cwd: process.cwd() } });
const claudePermission = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } } });
afterEach(() => vi.useRealTimers());

describe('request deadlines and ACP whole-turn lifetime', () => {
  it('retains ordinary RPC deadlines, aborts lifecycle requests, and ignores late responses without replay', async () => {
    vi.useFakeTimers();
    const wire = new TestWire(), rpc = new Rpc(wire, 120000), abort = new AbortController();
    const short = rpc.request('initialize', {});
    const timedOut = expect(short).rejects.toThrow('RPC timeout: initialize');
    const turn = rpc.request('session/prompt', {}, { timeoutMs: null, signal: abort.signal });
    const aborted = expect(turn).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(120001); await timedOut;
    abort.abort(new Error('cancelled')); await aborted;
    wire.emit({ id: 2, result: { stopReason: 'end_turn' } });
    expect(wire.messages).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
    await expect(rpc.request('unsafe', {}, { timeoutMs: null })).rejects.toThrow('lifecycle signal');
    rpc.close();
  });
  it('allows an ACP turn beyond 120 seconds and sends exactly one prompt', async () => {
    vi.useFakeTimers();
    const wire = acpWire(), worker = new AcpWorker(async () => wire);
    await worker.start(process.cwd(), 'long task');
    const next = worker.next(signal()); let settled = false; void next.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(600000);
    expect(settled).toBe(false);
    const prompts = wire.messages.filter(m => m.method === 'session/prompt'); expect(prompts).toHaveLength(1);
    wire.emit({ id: prompts[0].id, result: { stopReason: 'end_turn' } });
    expect(await next).toEqual({ type: 'completed', summary: 'ACP end_turn' });
    await worker.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a deadline-free request on close and removes its abort listener', async () => {
    const wire = new TestWire(), rpc = new Rpc(wire), lifetime = new AbortController();
    const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
    const ended = expect(rpc.request('session/prompt', {}, { timeoutMs: null, signal: lifetime.signal })).rejects.toThrow('RPC closed');
    rpc.close(); await ended;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    lifetime.abort(); expect(wire.messages).toHaveLength(1);
  });
  it('answers every pending permission cancelled, rejects stale answers, and awaits cancellation confirmation', async () => {
    vi.useFakeTimers();
    const wire = acpWire(), worker = new AcpWorker(async () => wire);
    await worker.start(process.cwd(), 'task');
    for (const id of [91, 92]) { wire.emit(acpPermission(id)); expect((await worker.next(signal())).type).toBe('permission'); }
    await worker.cancel(); await worker.cancel();
    expect(wire.messages.filter(m => m.method === 'session/cancel')).toHaveLength(1);
    for (const id of [91, 92]) {
      expect(wire.messages.find(m => m.id === id && m.result)?.result).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: String(id) });
      await expect(worker.respond(String(id), { allow: true })).rejects.toThrow('Unknown');
    }
    wire.emit(acpPermission(93)); expect(wire.messages.at(-1).result).toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(worker.steer('replay')).rejects.toThrow('already active');
    wire.emit({ id: wire.messages.find(m => m.method === 'session/prompt').id, result: { stopReason: 'cancelled' } });
    expect(await worker.next(signal())).toEqual({ type: 'failed', error: 'ACP stop reason: cancelled' });
    expect(vi.getTimerCount()).toBe(0); await worker.close();
  });
  it('closes an uncooperative cancelled turn after a bounded grace period', async () => {
    vi.useFakeTimers();
    const wire = acpWire(), worker = new AcpWorker(async () => wire);
    await worker.start(process.cwd(), 'task'); await worker.cancel();
    const closed = expect(worker.next(signal())).rejects.toThrow('RPC closed');
    await vi.advanceTimersByTimeAsync(30000); await closed;
    expect(wire.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await expect(worker.steer('replay')).rejects.toThrow(); await worker.close();
  });
  it('settles the whole-turn request and removes timers on close and disconnect', async () => {
    vi.useFakeTimers();
    for (const disconnect of [false, true]) {
      const wire = acpWire(), worker = new AcpWorker(async () => wire);
      await worker.start(process.cwd(), 'task'); await worker.cancel();
      const ended = expect(worker.next(signal())).rejects.toThrow();
      if (disconnect) wire.onClose!(new Error('connection lost')); else await worker.close();
      await ended; await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
      await worker.close();
    }
  });
});

describe('Codex failure and approval resolution', () => {
  it('preserves structured failed-turn diagnostics with redaction', async () => {
    const wire = codexWire(), worker = new CodexWorker(async () => wire);
    await worker.start(process.cwd(), 'task');
    wire.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'Quota exceeded token=private-value', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } }, additionalDetails: 'Bearer abcdefghi', token: 'private-key' } } } });
    const event = await worker.next(signal());
    expect(event).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(event)).toContain('Quota exceeded'); expect(JSON.stringify(event)).toContain('429');
    expect(JSON.stringify(event)).not.toMatch(/private-value|abcdefghi|private-key/); await worker.close();
  });
  it('retains a scoped error event when terminal failure lacks details', async () => {
    const wire = codexWire(), worker = new CodexWorker(async () => wire);
    await worker.start(process.cwd(), 'task');
    wire.emit({ method: 'error', params: { threadId: 'other', turnId: 'turn', error: { message: 'wrong' } } });
    wire.emit({ method: 'error', params: { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'Stream disconnected' } } });
    wire.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed' } } });
    expect(await worker.next(signal())).toMatchObject({ type: 'failed', error: expect.stringContaining('Stream disconnected') }); await worker.close();
  });
  it.each([17, '17'])('invalidates server-resolved request ID %s without answering it', async requestId => {
    const wire = codexWire(), worker = new CodexWorker(async () => wire);
    await worker.start(process.cwd(), 'task'); wire.emit(codexPermission(17)); await worker.next(signal());
    wire.emit({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId } });
    wire.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId } });
    wire.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId } });
    expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: '17' });
    await expect(worker.respond('17', { allow: true })).rejects.toThrow('Unknown');
    expect(wire.messages.filter(m => m.id === 17)).toHaveLength(0); await worker.close();
  });
  it('invalidates requests on interrupt and completion before late answers', async () => {
    const wire = codexWire(), worker = new CodexWorker(async () => wire);
    await worker.start(process.cwd(), 'task'); wire.emit(codexPermission(17)); await worker.next(signal());
    await worker.cancel(); expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: '17' });
    await expect(worker.respond('17', { allow: true })).rejects.toThrow('Unknown');
    wire.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
    expect((await worker.next(signal())).type).toBe('failed');
    wire.emit(codexPermission(18)); expect(wire.messages.at(-1).error).toBeDefined(); await worker.close();
  });
  it('clears a pending question before terminal completion', async () => {
    const wire = codexWire(), worker = new CodexWorker(async () => wire);
    await worker.start(process.cwd(), 'task');
    wire.emit({ id: 19, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', questions: [{ id: 'q', question: 'Language?' }] } });
    expect((await worker.next(signal())).type).toBe('question');
    wire.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: '19' });
    expect((await worker.next(signal())).type).toBe('completed');
    await expect(worker.respond('19', { allow: false, answer: 'TS' })).rejects.toThrow('Unknown'); await worker.close();
  });
});

describe('Claude error results and withdrawn controls', () => {
  it.each([
    { subtype: 'success', is_error: true, errors: [], result: 'API Error: 401 token=private-value', expected: 'API Error: 401' },
    { subtype: 'error_during_execution', errors: ['Quota exhausted', 'Bearer private-value'], result: 'unused', expected: 'Quota exhausted' },
    { subtype: 'error_max_turns', errors: [], expected: 'error_max_turns' },
    { subtype: 'success', is_error: true, api_error_status: 503, expected: 'HTTP 503' },
  ])('reports useful redacted diagnostics for $expected', async ({ expected, ...frame }) => {
    const { worker, wire } = await claude(); wire.emit({ type: 'result', ...frame });
    const event = await worker.next(signal());
    expect(event).toMatchObject({ type: 'failed', error: expect.stringContaining(expected) });
    expect(JSON.stringify(event)).not.toContain('private-value'); await worker.close();
  });
  it('invalidates a cancelled control without replying and ignores duplicate cancellation', async () => {
    const { worker, wire } = await claude(); wire.emit(claudePermission('approval')); await worker.next(signal());
    wire.emit({ type: 'control_cancel_request', request_id: 'approval' });
    wire.emit({ type: 'control_cancel_request', request_id: 'approval' });
    expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: 'approval' });
    await expect(worker.respond('approval', { allow: true })).rejects.toThrow('Unknown');
    expect(wire.messages.filter(m => m.type === 'control_response')).toHaveLength(0); await worker.close();
  });
  it('invalidates a withdrawn question as well as permissions', async () => {
    const { worker, wire } = await claude();
    wire.emit({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Language?' }] } } });
    expect((await worker.next(signal())).type).toBe('question');
    wire.emit({ type: 'control_cancel_request', request_id: 'question' });
    expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: 'question' });
    await expect(worker.respond('question', { allow: true, answer: 'TS' })).rejects.toThrow('Unknown'); await worker.close();
  });
  it('rejects stale answers after disconnect without sending onto a dead transport', async () => {
    const { worker, wire } = await claude(); wire.emit(claudePermission('approval')); await worker.next(signal());
    wire.onClose!(new Error('disconnected'));
    await expect(worker.respond('approval', { allow: true })).rejects.toThrow('Unknown');
    await expect(worker.next(signal())).rejects.toThrow('disconnected');
    expect(wire.messages.filter(m => m.type === 'control_response')).toHaveLength(0); await worker.close();
  });
  it('resolves stale approvals before a successful terminal result', async () => {
    const { worker, wire } = await claude(); wire.emit(claudePermission('approval')); await worker.next(signal());
    wire.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: 'approval' });
    expect(await worker.next(signal())).toEqual({ type: 'completed', summary: 'done' });
    await expect(worker.respond('approval', { allow: true })).rejects.toThrow('Unknown'); await worker.close();
  });
  it('invalidates approvals on interrupt and denies controls racing cancellation', async () => {
    const { worker, wire } = await claude(); wire.emit(claudePermission('approval')); await worker.next(signal());
    await worker.cancel(); expect(await worker.next(signal())).toEqual({ type: 'pendingResolved', id: 'approval' });
    await expect(worker.respond('approval', { allow: true })).rejects.toThrow('Unknown');
    wire.emit(claudePermission('late')); expect(wire.messages.at(-1).response.response.behavior).toBe('deny'); await worker.close();
  });
});
