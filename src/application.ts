import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Worker, Reasoner } from './contracts.js';
import { Redactor, within } from './safety.js';
import { Memory } from './memory.js';
import { Supervisor } from './supervisor.js';
import { createWorktree } from './worktree.js';
import { verifier } from './verification.js';
import { GrokReasoner } from './grok.js';
import { StdioWire, SocketWire } from './rpc.js';
import { AcpWorker } from './adapters/acp.js';
import { CodexWorker } from './adapters/codex.js';
import { PtyWorker } from './adapters/pty.js';
import { T3Worker } from './adapters/t3.js';
import { McpConnection, discoverT3 } from './adapters/mcp.js';
import type { Services } from './server.js';

export async function application(config: Config, reasonerOverride?: Reasoner): Promise<Services> {
  const repository = await realpath(config.repository);
  await mkdir(resolve(config.stateDirectory), { recursive: true, mode: 0o700 });
  const state = await realpath(config.stateDirectory);
  if (within(repository, state)) throw new Error('stateDirectory must be outside repository');
  const redactor = new Redactor([process.env.XAI_API_KEY ?? '', process.env.T3_BEARER_TOKEN ?? '', process.env.MCP_SERVER_TOKEN ?? '', ...Object.values(config.worker?.env ?? {}), ...Object.values(config.verify.env ?? {}), ...Object.values(config.setup?.env ?? {})]);
  const reasoner = reasonerOverride ?? (process.env.XAI_API_KEY && config.model ? new GrokReasoner(process.env.XAI_API_KEY, config.model, redactor) : undefined);
  let active = false;
  return { repository, reasoner, redactor, run: async (goal, signal) => {
    if (!reasoner) throw new Error('Set XAI_API_KEY and model before running tasks');
    if (active) throw new Error('A task is already running; concurrent runs are disabled');
    goal = z.string().min(1).max(4000).parse(goal);
    active = true; let cwd = '';
    try {
      const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
      if (runSignal.aborted) throw runSignal.reason;
      cwd = await createWorktree(repository, join(state, 'worktrees'));
      const directory = join(state, 'runs', randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (config.setup) {
        const setup = await verifier(config.setup.executable, config.setup.args, redactor, config.setup.env)(cwd, runSignal);
        if (!setup.passed) throw new Error('Owner-configured worktree setup failed: ' + setup.output);
      }
      let worker: Worker;
      const command = config.worker;
      const stdio = async (path: string) => new StdioWire(command!.executable, command!.args, path, command!.env);
      switch (config.adapter) {
        case 'acp': worker = new AcpWorker(stdio); break;
        case 'codex': worker = new CodexWorker(config.endpoint ? async () => SocketWire.connect(config.endpoint!) : stdio); break;
        case 'pty': worker = new PtyWorker(command!.executable, command!.args, redactor, command!.env); break;
        case 't3-mcp': {
          const endpoint = config.endpoint ?? (await discoverT3()).endpoint;
          worker = new T3Worker(await McpConnection.connect(endpoint, process.env.T3_BEARER_TOKEN ?? '', config.legacyEndpoint), config.projectId!); break;
        }
      }
      const memory = new Memory(join(directory, 'cold'), redactor);
      const supervisor = new Supervisor(worker, reasoner, memory, verifier(config.verify.executable, config.verify.args, redactor, config.verify.env), redactor);
      const result = { ...await supervisor.run({ cwd, goal, maxTurns: config.maxTurns, maxEvents: config.maxEvents, timeoutMs: config.timeoutMs, signal: runSignal }), worktree: cwd };
      await writeFile(join(directory, 'result.json'), redactor.redact(JSON.stringify(result, null, 2)), { mode: 0o600 });
      return result;
    } catch (e) { throw new Error(redactor.redact(`${String(e)}${cwd ? `; retained worktree: ${cwd}` : ''}`)); }
    finally { active = false; }
  } };
}
