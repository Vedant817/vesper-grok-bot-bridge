import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function managedPaths(homeOverride?: string) {
  const home = homeOverride ?? process.env.GROK_AGENT_BRIDGE_HOME ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'GrokAgentBridge')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'grok-agent-bridge'));
  if (!isAbsolute(home)) throw new Error('Managed installation directory must be absolute');
  const base = resolve(home);
  // `%` is expanded again by WScript.Shell.Run and by the user PATH; `;` splits PATH entries.
  // Both would silently corrupt autostart or PATH, so reject them before any state is written.
  if (process.platform === 'win32' && /[%;]/.test(base)) throw new Error('Managed installation directory cannot contain "%" or ";" on Windows; choose another folder with --home');
  if (/[\r\n]/.test(base)) throw new Error('Managed installation directory cannot contain line breaks');
  return { home: base, config: join(base, 'owner.json'), token: join(base, 'credential.bin'), receipt: join(base, 'runtime.json'), installation: join(base, 'installation.json'), launcher: join(base, 'launcher.cjs'), bin: join(base, 'bin') };
}
export type ManagedPaths = ReturnType<typeof managedPaths>;
