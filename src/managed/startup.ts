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
const ownership = (paths: ManagedPaths) => `' GrokAgentBridge: ${paths.home}`;
export const startupTaskName = (paths: ManagedPaths): string => `GrokAgentBridge-${createHash('sha256').update(paths.home.toLowerCase()).digest('hex').slice(0, 16)}`;
const daemonScript = (paths: ManagedPaths) => join(paths.home, 'daemon.vbs');

/** A hidden trampoline keeps logon silent while the scheduled task can still restart a crashed daemon. */
export function daemonVbs(paths: ManagedPaths, node = process.execPath): string {
  const command = `"${node}" "${paths.launcher}" daemon`.replace(/"/g, '""');
  return `${ownership(paths)}\r\nCreateObject("WScript.Shell").Run "${command}", 0, True\r\n`;
}

export function startupScript(paths: ManagedPaths): string {
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const actionArgs = `//B //NoLogo "${daemonScript(paths)}"`;
  return `$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; ` +
    `$action=New-ScheduledTaskAction -Execute ${literal(wscript)} -Argument ${literal(actionArgs)}; ` +
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
  await writeFile(daemonScript(paths), daemonVbs(paths), { mode: 0o600 });
  try {
    await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', startupScript(paths)], { windowsHide: true, timeout: 20000 });
    return { mode: 'scheduled-task' };
  } catch {
    const file = startupFile();
    const { readFile } = await import('node:fs/promises');
    let existing: string | undefined;
    try { existing = await readFile(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.startsWith(ownership(paths) + '\r\n')) throw new Error('Startup file belongs to another installation');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, daemonVbs(paths), { mode: 0o600 });
    return { mode: 'startup-folder', warning: 'Task Scheduler was unavailable. Startup-folder fallback starts hidden at logon but cannot restart a crashed process automatically.' };
  }
}

export async function removeAutostart(paths: ManagedPaths): Promise<{ removed: boolean }> {
  if (process.platform !== 'win32') return { removed: false };
  const description = literal(`Managed by GrokAgentBridge: ${paths.home}`);
  let schedulerError: unknown, removed = false;
  try {
    const { stdout } = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -ErrorAction SilentlyContinue; if($task -and $task.Description -eq ${description}){Unregister-ScheduledTask -TaskName ${literal(startupTaskName(paths))} -Confirm:$false; Write-Output 'removed'}`], { windowsHide: true, timeout: 20000 });
    if (stdout.includes('removed')) removed = true;
  } catch (error) { schedulerError = error; }
  const { readFile } = await import('node:fs/promises');
  const file = startupFile();
  try { if ((await readFile(file, 'utf8')).startsWith(ownership(paths) + '\r\n')) { await unlink(file); removed = true; } } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (schedulerError && !removed) throw new Error('Could not inspect/remove the managed scheduled task');
  await unlink(daemonScript(paths)).catch(() => {});
  return { removed };
}
