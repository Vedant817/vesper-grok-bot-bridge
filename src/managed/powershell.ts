import { join } from 'node:path';

/** Resolve the in-box Windows PowerShell binary without consulting PATH. */
export function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Windows PowerShell must discover its own compatible modules when called from pwsh 7. */
export function powershellEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^PSModule(?:Path|AnalysisCachePath)$/i.test(key)) delete env[key];
  // These short-lived helpers must not contend with the parent's on-disk module cache.
  env.PSModuleAnalysisCachePath = 'NUL';
  return env;
}
