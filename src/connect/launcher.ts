import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { resolveExecutable } from '../bridge/provider.js';
import type { ConnectBridgeLauncher } from './connection.js';

/** Public launcher hints and installed executable only; never inspect T3's private auth files. */
export async function discoverConnectLauncher(): Promise<ConnectBridgeLauncher | undefined> {
  const node = process.env.T3_ACP_MCP_NODE, entrypoint = process.env.T3_ACP_MCP_ENTRYPOINT;
  if (node && isAbsolute(node) && (!entrypoint || isAbsolute(entrypoint))) {
    try { await access(node); if (entrypoint) await access(entrypoint); return { command: node, args: entrypoint ? [entrypoint] : [] }; } catch {}
  }
  const launch = await resolveExecutable('t3');
  return launch ? { command: launch.executable, args: launch.args } : undefined;
}
