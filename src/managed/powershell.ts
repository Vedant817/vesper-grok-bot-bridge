import { join } from 'node:path';

/** Resolve the in-box Windows PowerShell binary without consulting PATH. */
export function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
