import { dirname, join } from 'node:path';

/** Resolve the in-box Windows PowerShell binary without consulting PATH. */
export function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Keep helpers on in-box Windows modules, independent of pwsh 7 and third-party module trees. */
export function powershellEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^PSModule(?:Path|AnalysisCachePath)$/i.test(key)) delete env[key];
  env.PSModulePath = join(dirname(powershellPath()), 'Modules');
  return env;
}
