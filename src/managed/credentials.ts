import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedPaths } from './paths.js';

// Static scripts receive values through stdin; secrets never enter process arguments.
// DACL work goes through DirectoryInfo.GetAccessControl/SetAccessControl: Set-Acl with a
// freshly constructed DirectorySecurity attempts a SACL write, which fails idempotent
// re-hardening with SeSecurityPrivilege unless the process is elevated.
const scripts = {
  acl: `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $d=[System.IO.DirectoryInfo]::new($v.path); $acl=$d.GetAccessControl(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){ [void]$acl.RemoveAccessRuleAll($rule) }; foreach($id in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){ $r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r) }; $d.SetAccessControl($acl)`,
  protect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($v); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`,
  unprotect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`
};

const clixmlError = /<S S="Error">([\s\S]*?)<\/S>/g;

// PowerShell serialises redirected diagnostics as CLIXML. Extract the message and
// strip anything that could echo protected material before surfacing it.
function helperFailure(stderr: string): string {
  const messages = [...stderr.matchAll(clixmlError)].map(match => match[1]
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
  const text = (messages.length > 0 ? messages.join(' ') : stderr)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

async function windowsHelper(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', settled = false;
    const failed = (reason?: string) => {
      const detail = helperFailure(stderr);
      return new Error(reason ?? (detail ? `Private credential operation failed: ${detail}` : 'Private credential operation failed'));
    };
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(output); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Private credential operation timed out')); }, 20000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 65536) { child.kill(); finish(failed()); } });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { if (stderr.length < 16384) stderr += chunk; });
    child.on('error', () => finish(failed()));
    child.on('exit', code => finish(code === 0 ? undefined : failed()));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export async function hardenHome(paths: ManagedPaths): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const info = await lstat(paths.home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed home must be a real directory');
  if (process.platform === 'win32') await windowsHelper(scripts.acl, JSON.stringify({ path: paths.home }));
  else await chmod(paths.home, 0o700);
}

export async function readCredential(paths: ManagedPaths): Promise<string> {
  const info = await lstat(paths.token);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid managed credential file');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Managed credential permissions must be private');
  const value = await readFile(paths.token, 'utf8');
  const prefix = 'grok-bridge-dpapi-v1\n';
  const token = process.platform === 'win32'
    ? value.startsWith(prefix) ? await windowsHelper(scripts.unprotect, value.slice(prefix.length)) : ''
    : value;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid managed credential');
  return token;
}

export async function ensureCredential(paths: ManagedPaths): Promise<string> {
  await hardenHome(paths);
  try { return await readCredential(paths); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const stored = process.platform === 'win32' ? `grok-bridge-dpapi-v1\n${await windowsHelper(scripts.protect, token)}` : token;
  const temporary = paths.token + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, stored, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, paths.token); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  return readCredential(paths);
}
