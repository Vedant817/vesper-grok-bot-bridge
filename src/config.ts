import { z } from 'zod';
const command = z.object({ executable: z.string().min(1), args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() }).strict();
export const configSchema = z.object({
  repository: z.string().min(1), stateDirectory: z.string().min(1), model: z.string().min(1).optional(),
  adapter: z.enum(['t3-mcp', 'acp', 'codex', 'pty']),
  worker: command.optional(), verify: command, setup: command.optional(),
  endpoint: z.string().url().optional(), legacyEndpoint: z.string().url().optional(), projectId: z.string().optional(),
  maxTurns: z.number().int().min(1).max(20).default(5), maxEvents: z.number().int().min(1).max(10000).default(500), timeoutMs: z.number().int().min(100).max(3600000).default(600000)
}).strict().superRefine((c, ctx) => {
  if (c.adapter === 't3-mcp' && !c.projectId) ctx.addIssue({ code: 'custom', message: 'T3 projectId required' });
  if (['acp', 'pty'].includes(c.adapter) && !c.worker) ctx.addIssue({ code: 'custom', message: 'Worker command required' });
  if (c.adapter === 'codex' && !c.worker && !c.endpoint) ctx.addIssue({ code: 'custom', message: 'Codex command or socket endpoint required' });
});
export type Config = z.infer<typeof configSchema>;
