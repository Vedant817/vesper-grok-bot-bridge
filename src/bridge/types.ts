import type { WorkerEvent } from '../contracts.js';
import type { ChangeSummary } from '../worktree.js';
export type SessionStatus = 'starting' | 'running' | 'awaiting_input' | 'awaiting_review' | 'interrupted' | 'failed' | 'cancelled' | 'finished';
export interface StartSession { provider: string; model: string; directory: string; task: string; requestId: string }
export interface BridgeEvent { cursor: number; event: WorkerEvent }
export interface Evidence { id: string; passed: boolean; output: string; contentHash: string; head: string; changes: ChangeSummary }
export interface SessionSnapshot {
  id: string; provider: string; model: string; directory: string; worktree: string; cwd: string;
  nativeId?: string; status: SessionStatus; turns: number; task: string;
  importId?: string;
  requestId: string; fingerprint: string; cursor: number; events: BridgeEvent[];
  taskHashes?: string[];
  pending: Extract<WorkerEvent, { type: 'question' | 'permission' }>[];
  evidence?: Evidence; error?: string;
}
