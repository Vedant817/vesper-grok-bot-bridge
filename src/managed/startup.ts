import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ManagedPaths } from './paths.js';
import { powershellPath } from './powershell.js';
export { startManaged } from './runtime.js';

const run = promisify(execFile);
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
export const startupTaskName = (paths: ManagedPaths): string => `GrokAgentBridge-${createHash('sha256').update(paths.home.toLowerCase()).digest('hex').slice(0, 16)}`;
export function startupScript(paths: ManagedPaths, node = process.execPath): string {
  const actionArgs = `"${paths.launcher}" daemon`;
  return `$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; ` +
    `$action=New-ScheduledTaskAction -Execute ${literal(node)} -Argument ${literal(actionArgs)}; ` +
    `$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user; ` +
    `$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; ` +
    `$settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; ` +
    `$existing=Get-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -ErrorAction SilentlyContinue; ` +
    `if($existing -and $existing.Description -ne ${literal(`Managed by GrokAgentBridge: ${paths.home}`)}){throw 'Existing startup task belongs to another installation'}; ` +
    `Register-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -Description ${literal(`Managed by GrokAgentBridge: ${paths.home}`)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`;
}
function startupFile(): string {
  if (!process.env.APPDATA) throw new Error('APPDATA is unavailable; cannot locate current-user Startup folder');
  return join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'GrokAgentBridge.vbs');
}
export async function installAutostart(paths: ManagedPaths): Promise<{ mode: string; warning?: string }> {
  if (process.platform !== 'win32') return { mode: 'unsupported', warning: 'Automatic logon startup currently supports Windows only' };
  try {
    await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', startupScript(paths)], { windowsHide: true, timeout: 20000 });
    return { mode: 'scheduled-task' };
  } catch {
    const file = startupFile();
    const { readFile } = await import('node:fs/promises');
    let existing: string | undefined;
    try { existing = await readFile(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const marker = `' GrokAgentBridge: ${paths.home}`;
    if (existing && !existing.startsWith(marker + '\r\n')) throw new Error('Startup file belongs to another installation');
    const command = `"${process.execPath}" "${paths.launcher}" daemon`;
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, `${marker}\r\nCreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`, { mode: 0o600 });
    return { mode: 'startup-folder', warning: 'Task Scheduler was unavailable. Startup-folder fallback starts hidden at logon but cannot restart a crashed process automatically.' };
  }
}
export async function removeAutostart(paths: ManagedPaths): Promise<void> {
  if (process.platform !== 'win32') return;
  const description = literal(`Managed by GrokAgentBridge: ${paths.home}`);
  let schedulerError: unknown;
  try { await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -ErrorAction SilentlyContinue; if($task -and $task.Description -eq ${description}){Unregister-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -Confirm:$false}`], { windowsHide: true, timeout: 20000 }); } catch (error) { schedulerError = error; }
  const { readFile } = await import('node:fs/promises');
  const file = startupFile();
  let removedFallback = false;
  try { if ((await readFile(file, 'utf8')).startsWith(`' GrokAgentBridge: ${paths.home}\r\n`)) { await unlink(file); removedFallback = true; } } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (schedulerError && !removedFallback) throw new Error('Could not inspect/remove the managed scheduled task');
}
