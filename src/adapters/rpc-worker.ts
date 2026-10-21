import { AsyncQueue, Rpc, type RpcMessage, type Wire } from '../rpc.js';
import type { Worker, WorkerEvent } from '../contracts.js';

export abstract class RpcWorker implements Worker {
  protected rpc?: Rpc;
  protected queue = new AsyncQueue<WorkerEvent>();
  protected pending = new Map<string, RpcMessage>();
  protected cwd = '';
  protected readonly lifetime = new AbortController();
  private closed = false;
  constructor(protected readonly connect: (cwd: string) => Promise<Wire>, private readonly jsonrpc = true) {}
  protected async open(cwd: string): Promise<Rpc> {
    this.cwd = cwd; const wire = await this.connect(cwd);
    if (this.closed) { wire.close(); throw new Error('Worker closed while connecting'); }
    const rpc = this.rpc = new Rpc(wire, 120000, this.jsonrpc);
    rpc.onClose = error => { this.pending.clear(); this.lifetime.abort(error); this.queue.close(error); };
    rpc.onRequest = message => {
      if (this.pending.has(String(message.id))) { rpc.close(); return; }
      if (this.pending.size >= 100) { rpc.reject(message.id!, 'Too many pending requests'); return; }
      const event = this.request(message);
      if (event === null) return;
      if (event) { this.pending.set(String(message.id), message); this.queue.push(event); }
      else rpc.reject(message.id!);
    };
    rpc.onNotification = message => this.notification(message);
    return rpc;
  }
  protected abstract request(message: RpcMessage): WorkerEvent | undefined | null;
  protected abstract notification(message: RpcMessage): void;
  abstract start(cwd: string, task: string): Promise<void>;
  abstract respond(id: string, response: { allow: boolean; answer?: string }): Promise<void>;
  abstract steer(message: string): Promise<void>;
  abstract cancel(): Promise<void>;
  next(signal: AbortSignal): Promise<WorkerEvent> { return this.queue.next(signal); }
  async close(): Promise<void> { this.closed = true; this.rpc?.close(); this.lifetime.abort(new Error('Worker closed')); this.pending.clear(); this.queue.close(); }
  protected resolvePending(id: string): void { if (this.pending.delete(id)) this.queue.push({ type: 'pendingResolved', id }); }
  protected resolveAllPending(): void { for (const id of this.pending.keys()) this.resolvePending(id); }
  protected take(id: string): RpcMessage { const message = this.pending.get(id); if (!message) throw new Error('Unknown or already answered request'); this.pending.delete(id); return message; }
}
