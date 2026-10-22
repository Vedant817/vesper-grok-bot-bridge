import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Worker } from '../contracts.js';
import { StdioWire, Rpc, childEnvironment } from '../rpc.js';
import { CodexWorker } from '../adapters/codex.js';
import { AcpWorker } from '../adapters/acp.js';
import { ClaudeWorker } from '../adapters/claude.js';
import { probeAcp, type AcpDiscovery } from './acp-discovery.js';

export interface Provider {
  id: string; label: string; models: string[]; available: boolean; reason?: string;
  protocol?: 'acp' | 'codex' | 'claude'; acp?: AcpDiscovery;
  create(options: { model: string; resumeId?: string }): Worker;
}
/** Owner-controlled configuration; never accepted as an MCP tool argument. */
export interface ProviderOverride { executable: string; args?: string[]; models?: string[]; env?: Record<string, string>; protocol?: 'acp' | 'codex' | 'claude'; authMethodId?: string }
interface Launch { executable: string; args: string[] }
async function exists(file: string): Promise<boolean> { try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } }
const npmPackages: Record<string, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
/** npm's Windows shims are .cmd/.ps1; run the package's declared JS bin under node instead. */
async function npmEntrypoint(name: string): Promise<Launch | undefined> {
  const packageName = npmPackages[name];
  if (!packageName) return;
  const dirs = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), process.env.APPDATA ? join(process.env.APPDATA, 'npm') : ''].filter(Boolean);
  for (const dir of dirs) {
    const packageDir = resolve(join(dir, 'node_modules', packageName));
    try {
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
      if (typeof bin !== 'string') continue;
      const target = resolve(packageDir, bin);
      if (!target.startsWith(packageDir + sep) || !await exists(target)) continue;
      return { executable: process.execPath, args: [target] };
    } catch {}
  }
}
/** Resolve executable files without executing PowerShell/cmd wrappers or interpolating shell text. */
export async function resolveExecutable(name: string): Promise<Launch | undefined> {
  const windows = process.platform === 'win32';
  const names = isAbsolute(name) ? [name] : (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).flatMap(dir => windows ? [join(dir, `${name}.exe`), join(dir, name)] : [join(dir, name)]);
  if (windows && !isAbsolute(name)) {
    if (name === 'claude') names.push(join(homedir(), '.local', 'bin', 'claude.exe'));
    if (name === 'opencode') names.push(join(homedir(), '.bun', 'bin', 'opencode.exe'));
  }
  if (!isAbsolute(name) && name === 'grok') names.push(join(homedir(), '.grok', 'bin', windows ? 'grok.exe' : 'grok'));
  for (const candidate of names) {
    if (!await exists(candidate)) continue;
    const suffix = extname(candidate).toLowerCase();
    if (['.ps1', '.cmd', '.bat'].includes(suffix)) continue;
    if (suffix === '.js' || suffix === '.mjs' || suffix === '.cjs') return { executable: process.execPath, args: [resolve(candidate)] };
    if (windows && !['.exe', '.com'].includes(suffix)) continue;
    return { executable: resolve(candidate), args: [] };
  }
  if (windows && !isAbsolute(name)) return npmEntrypoint(name);
  return undefined;
}
async function modelsFor(id: string, launch: Launch, env?: Record<string, string>): Promise<string[]> {
  if (id === 'claude') return []; // CLI accepts exact IDs and aliases; no supported model-list CLI.
  if (id === 'opencode') {
    try {
      const result = await promisify(execFile)(launch.executable, [...launch.args, 'models'], { shell: false, windowsHide: true, env: childEnvironment(env), timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      return [...new Set(result.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^[\w.-]+\/[\w./:-]+$/.test(s)))];
    } catch { return []; }
  }
  const wire = new StdioWire(launch.executable, [...launch.args, 'app-server'], process.cwd(), env), rpc = new Rpc(wire, 10000, false);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'grok-agent-bridge-discovery', version: '0.1.0' }, capabilities: {} }); rpc.notify('initialized');
    const result = await rpc.request('model/list', { limit: 100 });
    return [...new Set<string>((result.data ?? []).map((m: any) => m.model).filter((m: unknown): m is string => typeof m === 'string'))];
  } catch { return []; } finally { rpc.close(); }
}
/** An empty model catalog means native validation, never implicit model substitution. */
export async function discoverProviders(overrides: Record<string, ProviderOverride> = {}): Promise<Provider[]> {
  const providers = await Promise.all([...new Set(['codex', 'opencode', 'claude', 'grok-build', ...Object.keys(overrides)])].map(async id => {
    const label = ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', 'grok-build': 'Grok Build', antigravity: 'Antigravity' } as Record<string, string>)[id] ?? id;
    const override = overrides[id], launch = await resolveExecutable(override?.executable ?? (id === 'grok-build' ? 'grok' : id));
    const unavailable = (reason: string): Provider => ({ id, label, models: [], available: false, reason, create() { throw new Error(reason); } });
    if (!launch) return unavailable('Executable unavailable; install provider or configure a native executable');
    const protocol = override?.protocol ?? (id === 'codex' ? 'codex' : ['opencode', 'grok-build'].includes(id) ? 'acp' : id === 'claude' ? 'claude' : undefined);
    if (!protocol) return unavailable('Custom providers require an explicit supported protocol');
    const args = override?.args ?? (id === 'grok-build' && protocol === 'acp' ? ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'] : protocol === 'codex' ? ['app-server'] : protocol === 'acp' ? ['acp'] : []);
    let acp: AcpDiscovery | undefined;
    if (protocol === 'acp') {
      try { acp = await probeAcp(() => new StdioWire(launch.executable, [...launch.args, ...args], process.cwd(), override?.env)); }
      catch { return { ...unavailable('ACP initialization failed or timed out; verify the configured executable, arguments and ACP v1 support'), protocol }; }
    }
    const nativeModelProtocol = id === 'codex' ? protocol === 'codex' : id === 'opencode' ? protocol === 'acp' : id === 'claude' && protocol === 'claude';
    const models = override?.models ?? (override?.args || !nativeModelProtocol ? [] : await modelsFor(id, launch, override?.env));
    return { id, label, models, available: true, protocol, ...(acp ? { acp } : {}),
      create(options: { model: string; resumeId?: string }): Worker {
        if (!options.model.trim() || (models.length && !models.includes(options.model))) throw new Error('Requested model unavailable');
        if (protocol === 'claude') return new ClaudeWorker(async cwd => new StdioWire(launch.executable, [...launch.args, ...args, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--model', options.model, ...(options.resumeId ? ['--resume', options.resumeId] : [])], cwd, override?.env), options.resumeId);
        const connect = async (cwd: string) => new StdioWire(launch.executable, [...launch.args, ...args], cwd, override?.env);
        return protocol === 'codex' ? new CodexWorker(connect, options) : new AcpWorker(connect, { ...options, authMethodId: override?.authMethodId ?? (id === 'grok-build' ? 'cached_token' : undefined) });
      }
    } satisfies Provider;
  }));
  for (const [id, label] of [['antigravity', 'Antigravity'], ['grok-bot', 'Grok Bot']] as const) if (!providers.some(p => p.id === id)) providers.push({ id, label, models: [], available: false, reason: id === 'grok-bot' ? 'Grok Bot is the MCP supervisor client; no documented worker session-control API configured' : 'Configure an owner-enrolled standalone ACP executable; app-private authentication is not reused', create() { throw new Error('Provider has no supported worker interface'); } });
  return providers;
}
