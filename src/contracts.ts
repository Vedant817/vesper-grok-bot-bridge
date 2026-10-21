import type { Permission } from './safety.js';
/** A previously pending native request was withdrawn or already answered. */
export class PendingRequestResolvedError extends Error {
  constructor(readonly requestId: string) {
    super('Unknown or already answered request: pending request resolved');
    this.name = 'PendingRequestResolvedError';
  }
}
export type WorkerEvent =
  | { type: 'output'; text: string }
  | { type: 'question'; id: string; question: string; options?: string[]; allowCustomAnswer?: boolean }
  | { type: 'permission'; id: string; request: Permission }
  | { type: 'pendingResolved'; id: string }
  | { type: 'completed'; summary: string }
  | { type: 'failed'; error: string };
export interface Worker {
  readonly nativeSessionId?: string;
  start(cwd: string, task: string): Promise<void>;
  next(signal: AbortSignal): Promise<WorkerEvent>;
  respond(id: string, response: { allow: boolean; answer?: string }): Promise<void>;
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export interface Reasoner {
  answer(question: string, context: string, options?: string[], signal?: AbortSignal): Promise<string>;
  evaluate(goal: string, evidence: string, signal?: AbortSignal): Promise<{ accept: boolean; feedback: string }>;
}
