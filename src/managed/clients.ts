import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { resolveExecutable } from '../bridge/provider.js';
import type { ManagedPaths } from './paths.js';
const run = promisify(execFile);
const name = 'coding-agent-bridge';
export function mergeOpenCodeConfig(text: string, paths: ManagedPaths): { text: string; changed: boolean } {
  const errors: ParseError[] = [], config = parse(text, errors, { allowTrailingComma: true }) ?? {};
  if (errors.length || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenCode config is not valid JSONC');
  const wanted = { type: 'local', command: [process.execPath, paths.launcher, 'connect'], enabled: true };
  const current = config.mcp?.[name];
  if (current !== undefined) {
    if (JSON.stringify(current.command) === JSON.stringify(wanted.command) && current.type === 'local') return { text, changed: false };
    throw new Error('Existing OpenCode coding-agent-bridge entry conflicts; configuration was preserved');
  }
  return { text: applyEdits(text, modify(text, ['mcp', name], wanted, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })), changed: true };
}
export async function registerManagedClients(paths: ManagedPaths): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const id of ['codex', 'claude']) {
    const launch = await resolveExecutable(id);
    if (!launch) { result[id] = 'not-installed'; continue; }
    try {
      let existing: string | undefined;
      try { existing = (await run(launch.executable, [...launch.args, 'mcp', 'get', name], { windowsHide: true, timeout: 15000 })).stdout; } catch (error: any) {
        // A missing entry is the only expected nonzero result. Authentication or malformed configuration must not be overwritten.
        const message = `${error.stdout ?? ''} ${error.stderr ?? ''}`;
        if (!/not found|no mcp server|does not exist|could not find/i.test(message)) throw new Error('Could not inspect existing MCP configuration');
      }
      if (existing) { result[id] = 'existing-entry-preserved'; continue; }
      const args = id === 'codex' ? ['mcp', 'add', name, '--', process.execPath, paths.launcher, 'connect'] : ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', name, '--', process.execPath, paths.launcher, 'connect'];
      await run(launch.executable, [...launch.args, ...args], { windowsHide: true, timeout: 20000 });
      result[id] = 'registered';
    } catch (error: any) { result[id] = `not-registered: ${error.message?.split('\n')[0] ?? 'registration failed'}`; }
  }
  if (!await resolveExecutable('opencode')) result.opencode = 'not-installed';
  else {
    try {
      const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
      const jsonc = join(configDir, 'opencode.jsonc'), json = join(configDir, 'opencode.json');
      let file = json, text = '{}\n';
      try { text = await readFile(jsonc, 'utf8'); file = jsonc; } catch (error: any) { if (error.code !== 'ENOENT') throw error; try { text = await readFile(json, 'utf8'); } catch (other: any) { if (other.code !== 'ENOENT') throw other; } }
      const merged = mergeOpenCodeConfig(text, paths);
      if (merged.changed) {
        await mkdir(dirname(file), { recursive: true });
        try { await copyFile(file, `${file}.bridge-backup-${Date.now()}`); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        await writeFile(file, merged.text, { mode: 0o600 });
      }
      result.opencode = merged.changed ? 'registered' : 'already-registered';
    } catch (error: any) { result.opencode = `not-registered: ${error.message}`; }
  }
  return result;
}
