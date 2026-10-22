import { access, lstat, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { resolveExecutable } from '../bridge/provider.js';
import type { ConnectBridgeLauncher } from './connection.js';

/** Read T3's public desktop shim as data; never execute cmd, PowerShell, or its shell text. */
export async function readDesktopLauncher(file: string): Promise<ConnectBridgeLauncher | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) return;
    const text = await readFile(file, 'utf8');
    if (!/^rem Written by T3 Code: runs the desktop app's bundled t3 CLI\.\r?$/m.test(text) || !/^set "ELECTRON_RUN_AS_NODE=1"\r?$/m.test(text)) return;
    const candidates = text.split(/\r?\n/).filter(line => /^\s*@?(?:"|(?:call|start)\b)/i.test(line));
    if (candidates.length !== 1) return;
    const launch = /^"([^"\r\n]+\.exe)" "([^"\r\n]+\.mjs)" %\*$/i.exec(candidates[0]);
    if (!launch) return;
    const [, command, entrypoint] = launch;
    const name = process.platform === 'win32' ? basename(command).toLowerCase() : basename(command);
    const allowedNames = process.platform === 'win32' ? ['t3 code.exe', 't3 code (nightly).exe'] : ['T3 Code.exe', 'T3 Code (Nightly).exe'];
    if (!isAbsolute(command) || !isAbsolute(entrypoint) || !allowedNames.includes(name)) return;
    const archive = join(dirname(command), 'resources', 'server.asar');
    const expected = join(archive, 'apps', 'server', 'dist', 'bin.mjs');
    const canonical = (value: string) => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
    if (canonical(entrypoint) !== canonical(expected)) return;
    if (!(await stat(command)).isFile() || !(await stat(archive)).isFile()) return;
    return { command, args: [expected] };
  } catch { return undefined; }
}

/** Public launcher hints and installed executable only; never inspect T3's private auth files. */
export async function discoverConnectLauncher(): Promise<ConnectBridgeLauncher | undefined> {
  const node = process.env.T3_ACP_MCP_NODE, entrypoint = process.env.T3_ACP_MCP_ENTRYPOINT;
  if (node && isAbsolute(node) && (!entrypoint || isAbsolute(entrypoint))) {
    try { await access(node); if (entrypoint) await access(entrypoint); return { command: node, args: entrypoint ? [entrypoint] : [] }; } catch {}
  }
  const launch = await resolveExecutable('t3');
  if (launch) return { command: launch.executable, args: launch.args };
  if (process.platform === 'win32') return readDesktopLauncher(join(homedir(), '.t3', 'bin', 't3.cmd'));
  return undefined;
}
