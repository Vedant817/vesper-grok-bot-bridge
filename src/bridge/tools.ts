import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeService } from './service.js';
import type { Redactor } from '../safety.js';

/** Grok Bot (or another MCP host) is the reasoning supervisor. */
export function registerBridgeTools(server: McpServer, bridge: BridgeService, redactor: Redactor): void {
  const id = z.string().min(1).max(256);
  const task = z.string().min(1).max(16000);
  const invoke = async (fn: () => unknown | Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: redactor.json(await fn()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: redactor.redact(error instanceof Error ? error.message : 'Bridge operation failed') }] }; }
  };
  server.registerTool('agent_discover', { description: 'Discover installed coding providers, exact model IDs, availability and limitations. Grok Bot is the MCP caller; never substitute Grok Build for Grok Bot.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => invoke(() => bridge.discover()));
  server.registerTool('agent_start', { description: 'Start the chosen coding provider and model in an isolated worktree of an owner-enrolled directory. Supply a stable unique requestId for retry safety; retain the returned session ID.', inputSchema: { provider: id, model: id, directory: z.string().min(1).max(4096), task, requestId: id } }, async args => invoke(() => bridge.start(args)));
  server.registerTool('agent_sessions', { description: 'List retained bridge sessions, native session IDs and review state.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => invoke(() => bridge.list()));
  server.registerTool('agent_read', { description: 'Read redacted session activity after a cursor, pending questions/permissions and task status. A completed worker turn still requires review and verification.', inputSchema: { sessionId: id, cursor: z.number().int().min(0).default(0) }, annotations: { readOnlyHint: true } }, async args => invoke(() => bridge.read(args.sessionId, args.cursor)));
  server.registerTool('agent_respond', { description: 'Answer a pending coding-agent question or permission request. Evaluate against the task and repository context first. Deterministic blocked operations cannot be approved.', inputSchema: { sessionId: id, requestId: id, answer: z.string().max(16000).optional(), allow: z.boolean().optional() } }, async args => invoke(() => bridge.respond(args.sessionId, args.requestId, { answer: args.answer, allow: args.allow })));
  server.registerTool('agent_followup', { description: 'Continue a completed turn with corrections or the next milestone, preserving the native session and chosen model. Bounded by owner turn limits.', inputSchema: { sessionId: id, task } }, async args => invoke(() => bridge.followup(args.sessionId, args.task)));
  server.registerTool('agent_verify', { description: 'Run the immutable owner-configured verifier and collect current Git change evidence. Read the results before accepting or sending corrective feedback.', inputSchema: { sessionId: id } }, async args => invoke(() => bridge.verify(args.sessionId)));
  server.registerTool('agent_finish', { description: 'Accept reviewed work using the latest passing verification evidence ID. Rejects failed or stale evidence. Never merges or pushes.', inputSchema: { sessionId: id, evidenceId: id } }, async args => invoke(() => bridge.finish(args.sessionId, args.evidenceId)));
  server.registerTool('agent_cancel', { description: 'Interrupt a bridge-owned coding session while retaining its worktree and evidence.', inputSchema: { sessionId: id } }, async args => invoke(() => bridge.cancel(args.sessionId)));
  server.registerTool('agent_resume', { description: 'Resume a retained interrupted native session in its original bridge worktree. Old permission IDs are invalid; native provider resume support is required.', inputSchema: { sessionId: id, task } }, async args => invoke(() => bridge.resume(args.sessionId, args.task)));
  server.registerTool('agent_attach', { description: 'Enter an existing native coding session explicitly enrolled by the owner, preserving its provider, model and isolated worktree. Discover import IDs first. Cannot hijack arbitrary terminal processes.', inputSchema: { importId: id, task, requestId: id } }, async args => invoke(() => bridge.attach(args.importId, args.task, args.requestId)));
}
