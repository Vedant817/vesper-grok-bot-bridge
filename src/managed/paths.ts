import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function managedPaths(homeOverride?: string) {
  const home = homeOverride ?? process.env.GROK_AGENT_BRIDGE_HOME ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'GrokAgentBridge')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'grok-agent-bridge'));
  if (!isAbsolute(home)) throw new Error('Managed installation directory must be absolute');
  const base = resolve(home);
  return { home: base, config: join(base, 'owner.json'), token: join(base, 'credential.bin'), receipt: join(base, 'runtime.json'), installation: join(base, 'installation.json'), launcher: join(base, 'launcher.cjs'), bin: join(base, 'bin') };
}
export type ManagedPaths = ReturnType<typeof managedPaths>;
