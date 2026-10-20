import type { Permission } from './safety.js';
export type WorkerEvent =
  | { type: 'output'; text: string }
  | { type: 'question'; id: string; question: string; options?: string[]; allowCustomAnswer?: boolean }
  | { type: 'permission'; id: string; request: Permission }
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
