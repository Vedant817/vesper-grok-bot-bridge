import { describe, expect, it } from 'vitest';
import { AcpWorker } from '../src/adapters/acp.js';
import { CodexWorker } from '../src/adapters/codex.js';
import { ClaudeWorker } from '../src/adapters/claude.js';
import { resolveExecutable } from '../src/bridge/provider.js';
import type { RpcMessage, Wire } from '../src/rpc.js';

class WireFixture implements Wire {
  messages: any[] = [];
  onMessage?: (m: RpcMessage) => void;
  onClose?: (e: Error) => void;
  constructor(readonly reply: (m: any) => any) {}
  send(m: any): void { this.messages.push(m); const r = this.reply(m); if (r !== undefined) queueMicrotask(() => this.onMessage?.(m.type === 'control_request' ? r : { id: m.id, result: r })); }
  emit(m: any): void { this.onMessage?.(m); }
  close(): void {}
}
const signal = () => AbortSignal.timeout(1000);
describe('portable native sessions', () => {
  it('pins the Codex requested model and rejects an ignored model', async () => {
    const wire = new WireFixture(m => m.method === 'initialize' ? {} : m.method === 'thread/start' ? { thread: { id: 't' }, model: 'wrong' } : undefined);
    const worker = new CodexWorker(async () => wire, { model: 'exact' });
    try {
      await expect(worker.start(process.cwd(), 'task')).rejects.toThrow('confirm requested model');
      expect(wire.messages.find(m => m.method === 'thread/start').params.model).toBe('exact');
      expect(wire.messages.some(m => m.method === 'turn/start')).toBe(false);
    } finally { await worker.close(); }
  });
  it('validates persisted Codex cwd before resume and never starts a replacement', async () => {
    const wire = new WireFixture(m => m.method === 'initialize' ? {} : m.method === 'thread/read' ? { thread: { cwd: '/wrong' } } : undefined);
    const worker = new CodexWorker(async () => wire, { resumeId: 'saved', model: 'exact' });
    try { await expect(worker.start(process.cwd(), 'task')).rejects.toThrow('directory mismatch'); expect(wire.messages.map(m => m.method)).not.toContain('thread/resume'); }
    finally { await worker.close(); }
  });
  it('binds Codex file approval to actual in-worktree change evidence and rejects opaque scope', async () => {
    const wire = new WireFixture(m => ({ initialize: {}, 'thread/start': { thread: { id: 't' } }, 'turn/start': { turn: { id: 'turn' } } })[m.method as string]);
    const worker = new CodexWorker(async () => wire);
    try {
      await worker.start(process.cwd(), 'task');
      wire.emit({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'edit', type: 'fileChange', changes: [{ path: 'bridge-test-new.txt', kind: { type: 'add' }, diff: '+test' }] } } });
      wire.emit({ id: 4, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'edit' } });
      expect(await worker.next(signal())).toMatchObject({ type: 'permission', request: { cwd: process.cwd(), description: expect.stringContaining('+test') } });
      await worker.respond('4', { allow: false });
      wire.emit({ id: 5, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'unknown' } });
      const unknown = await worker.next(signal()); expect(unknown.type === 'permission' && unknown.request.cwd).toBeUndefined();
      wire.emit({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'outside', type: 'fileChange', changes: [{ path: '../outside.txt', kind: { type: 'add' }, diff: '+test' }] } } });
      wire.emit({ id: 6, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'outside' } });
      const outside = await worker.next(signal()); expect(outside.type === 'permission' && outside.request.cwd).toBeUndefined();
    } finally { await worker.close(); }
  });
  it('loads ACP sessions and selects an advertised model before prompting', async () => {
    const wire = new WireFixture(m => ({ initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, 'session/load': { models: { availableModels: [{ modelId: 'exact' }] } }, 'session/set_model': {}, 'session/prompt': { stopReason: 'end_turn' } })[m.method as string]);
    const worker = new AcpWorker(async () => wire, { resumeId: 'saved', model: 'exact' });
    try {
      await worker.start(process.cwd(), 'task'); expect(worker.nativeSessionId).toBe('saved');
      expect(wire.messages.filter(m => m.method).map(m => m.method)).toEqual(['initialize', 'session/load', 'session/set_model', 'session/prompt']);
      expect((await worker.next(signal())).type).toBe('completed');
    } finally { await worker.close(); }
  });
  it('refuses unsupported ACP resume and unadvertised models', async () => {
    const wire = new WireFixture(m => m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: 'new' } : undefined);
    const resumed = new AcpWorker(async () => wire, { resumeId: 'saved' });
    await expect(resumed.start(process.cwd(), 'task')).rejects.toThrow('session loading'); await resumed.close();
    const fresh = new AcpWorker(async () => wire, { model: 'missing' });
    await expect(fresh.start(process.cwd(), 'task')).rejects.toThrow('model is unavailable'); await fresh.close();
  });
  it('does not attach trusted cwd to ACP file mutations without scoped locations', async () => {
    const wire = new WireFixture(m => m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: 's' } : undefined);
    const worker = new AcpWorker(async () => wire);
    try {
      await worker.start(process.cwd(), 'task');
      for (const [id, toolCall] of [[1, { kind: 'edit' }], [2, { kind: 'edit', locations: [{ path: '../outside.txt' }] }]] as const) {
        wire.emit({ id, method: 'session/request_permission', params: { sessionId: 's', toolCall } });
        const event = await worker.next(signal()); expect(event.type === 'permission' && event.request.cwd).toBeUndefined();
      }
    } finally { await worker.close(); }
  });
  it('responds to native Claude permissions/questions and supports sequential prompts', async () => {
    const wire = new WireFixture(m => m.request?.subtype === 'initialize' ? { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } } : undefined);
    const worker = new ClaudeWorker(async () => wire);
    try {
      await worker.start(process.cwd(), 'task');
      wire.emit({ type: 'system', subtype: 'init', session_id: 'native', cwd: process.cwd() });
      wire.emit({ type: 'control_request', request_id: 'outside', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '../outside.txt', content: 'unsafe' } } });
      const outside = await worker.next(signal()); expect(outside.type === 'permission' && outside.request.cwd).toBeUndefined();
      await worker.respond('outside', { allow: false });
      wire.emit({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } } });
      expect(await worker.next(signal())).toMatchObject({ type: 'permission', request: { command: 'rm -rf /' } });
      await worker.respond('permission', { allow: false });
      expect(wire.messages.at(-1).response.response.behavior).toBe('deny');
      wire.emit({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Language?', options: [{ label: 'TS' }] }] } } });
      expect((await worker.next(signal())).type).toBe('question'); await worker.respond('question', { allow: false, answer: 'TS' });
      expect(wire.messages.at(-1).response.response.updatedInput.answers).toEqual({ 'Language?': 'TS' });
      await expect(worker.respond('question', { allow: true })).rejects.toThrow('already answered');
      wire.emit({ type: 'result', subtype: 'success', result: 'done', is_error: false });
      expect((await worker.next(signal())).type).toBe('completed'); expect(worker.nativeSessionId).toBe('native');
      await worker.steer('follow-up'); expect(wire.messages.at(-1)).toMatchObject({ type: 'user', session_id: 'native', message: { content: 'follow-up' } });
    } finally { await worker.close(); }
  });
  it('never executes Windows shell wrappers as native executables', async () => {
    expect(await resolveExecutable('C:/unavailable-bridge-test/unsafe.cmd')).toBeUndefined();
  });
});
