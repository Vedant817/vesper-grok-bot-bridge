import { join } from 'node:path';

/** Resolve the in-box Windows PowerShell binary without consulting PATH. */
export function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Avoid scanning unrelated installed modules to resolve helper cmdlets. */
export function powershellScript(script: string, modules: readonly ('Microsoft.PowerShell.Utility' | 'Microsoft.PowerShell.Security' | 'ScheduledTasks')[] = ['Microsoft.PowerShell.Utility']): string {
  return modules.map(name => `Import-Module "$PSHOME\\Modules\\${name}\\${name}.psd1" -ErrorAction Stop; `).join('') + script;
}

/** Windows PowerShell must discover its own compatible modules when called from pwsh 7. */
export function powershellEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^PSModule(?:Path|AnalysisCachePath)$/i.test(key)) delete env[key];
  return env;
}
