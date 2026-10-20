import { z } from 'zod';

const command = z.object({ executable: z.string().min(1), args: z.array(z.string()), env: z.record(z.string()).optional() }).strict();
export const bridgeConfigSchema = z.object({
  stateDirectory: z.string().min(1),
  roots: z.array(z.object({ directory: z.string().min(1), verify: command }).strict()).min(1),
  imports: z.array(z.object({ id: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), nativeId: z.string().min(1), worktree: z.string().min(1), directory: z.string().optional() }).strict()).default([]),
  maxTurns: z.number().int().min(1).max(30).default(8),
  maxEvents: z.number().int().min(10).max(2000).default(200),
  maxSessions: z.number().int().min(1).max(1000).default(100),
}).strict();
export type BridgeConfig = z.input<typeof bridgeConfigSchema>;
