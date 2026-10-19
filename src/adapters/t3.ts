import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { realpath } from 'node:fs/promises';
import type { Worker, WorkerEvent } from '../contracts.js';
import { git } from '../worktree.js';
import { t3Thread, type ToolCaller } from './mcp.js';

/** T3 pending-request tools expose questions, not runtime approvals. */
export class T3Worker implements Worker {
  private thread?: string;
  private run?: string | null;
  private requests = new Map<string, { requestId: string; questionId: string; options: { label: string; value?: string | null }[]; allowCustom: boolean }>();
  private events: WorkerEvent[] = [];
  private terminal = false;
  private stopped = false;
  constructor(private readonly mcp: ToolCaller, private readonly projectId: string, private readonly title = 'Supervised task') {}
  async start(cwd: string, task: string): Promise<void> {
    const branch = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
    const result = t3Thread.parse(await this.mcp.call('t3_thread_launch', { projectId: this.projectId, title: this.title, message: task, runtimeMode: 'approval-required', workspaceStrategy: { type: 'existing_worktree', worktreePath: cwd, ...(branch ? { branch } : {}) } }));
    this.thread = result.threadId; this.run = result.runId;
    for (let attempt = 0; attempt < 40 && !this.stopped; attempt++) {
      const state = await this.mcp.call('t3_thread_read', { threadId: this.thread, limit: 1 });
      if (state.thread?.worktreePath) {
        if (await realpath(state.thread.worktreePath) === await realpath(cwd)) return;
        await this.cancel(); throw new Error('T3 workspace binding mismatch');
      }
      if (!['preparing', 'queued', 'starting'].includes(state.thread?.status)) break;
      await delay(250);
    }
    await this.cancel(); throw new Error('T3 workspace binding was not confirmed before preparation limit');
  }
  async next(signal: AbortSignal): Promise<WorkerEvent> {
    while (!signal.aborted && !this.stopped) {
      if (this.events.length) return this.events.shift()!;
      const pending = await this.mcp.call('t3_pending_request_list', { threadId: this.thread }, signal);
      if (!Array.isArray(pending.requestIds)) throw new Error('Invalid T3 pending request contract');
      for (const requestId of pending.requestIds) {
        if ([...this.requests.values()].some(q => q.requestId === requestId)) continue;
        const request = await this.mcp.call('t3_pending_request_read', { threadId: this.thread, requestId }, signal);
        if (!Array.isArray(request.questions) || request.questions.length !== 1 || request.questions[0].multiSelect) throw new Error('Unsupported T3 multi-question or multiselect request; no answer sent');
        const q = request.questions[0], id = `${requestId}:${q.id}`;
        this.requests.set(id, { requestId, questionId: q.id, options: q.options ?? [], allowCustom: q.allowCustomAnswer === true });
        this.events.push({ type: 'question', id, question: q.question, options: q.options?.map((o: any) => o.label) });
      }
      if (this.events.length) continue;
      const state = await this.mcp.call('t3_thread_wait', { threadId: this.thread, ...(this.run ? { runId: this.run } : {}), timeoutMs: 1000 }, signal);
      if (state.runId) this.run = state.runId;
      if (state.status === 'waiting' && pending.requestIds.length === 0) {
        const read = await this.mcp.call('t3_thread_read', { threadId: this.thread, limit: 1 }, signal);
        if (read.thread?.pendingRequestCount > 0) return { type: 'failed', error: 'T3 runtime approval is pending; question-response MCP tools cannot approve it' };
      }
      if (state.status === 'completed' && !this.terminal) {
        this.terminal = true;
        const read = await this.mcp.call('t3_thread_read', { threadId: this.thread, limit: 20, maxCharsPerItem: 3000 }, signal);
        return { type: 'completed', summary: JSON.stringify(read.items) };
      }
      if (['failed', 'cancelled', 'interrupted', 'rolled_back'].includes(state.status)) return { type: 'failed', error: `T3 ${state.status}` };
      await delay(100, undefined, { signal });
    }
    throw signal.reason ?? new Error('T3 worker stopped');
  }
  async respond(id: string, response: { allow: boolean; answer?: string }): Promise<void> {
    const request = this.requests.get(id); if (!request) throw new Error('Unknown T3 question');
    if (response.answer === undefined) throw new Error('T3 question response requires answer; approvals unavailable');
    const option = request.options.find(o => o.label === response.answer || o.value === response.answer);
    if (!option && !request.allowCustom) throw new Error('Answer does not match a T3 option');
    await this.mcp.call('t3_pending_request_respond', { threadId: this.thread, requestId: request.requestId, answers: { [request.questionId]: option?.value ?? option?.label ?? response.answer } });
    this.requests.delete(id);
  }
  async send(message: string, mode: 'auto' | 'steer' | 'restart' = 'auto'): Promise<void> {
    const result = await this.mcp.call('t3_thread_send', { threadId: this.thread, message, mode, clientRequestId: randomUUID() });
    if (typeof result.runId !== 'string') throw new Error('T3 send missing runId');
    this.run = result.runId; this.terminal = false;
  }
  async steer(message: string): Promise<void> { await this.send(message); }
  async cancel(): Promise<void> { this.stopped = true; if (this.thread && !this.terminal) await this.mcp.call('t3_thread_interrupt', { threadId: this.thread }); }
  async close(): Promise<void> { await this.mcp.close(); }
}
