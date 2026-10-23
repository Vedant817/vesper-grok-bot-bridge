import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedPaths } from './paths.js';
import { powershellEnvironment, powershellPath, powershellScript } from './powershell.js';

// Static scripts receive values through stdin; secrets never enter process arguments.
// stdin is base64 so Windows PowerShell's OEM code-page decoding cannot mangle paths.
// DACL work goes through DirectoryInfo.GetAccessControl/SetAccessControl: Set-Acl with a
// freshly constructed DirectorySecurity attempts a SACL write, which fails idempotent
// re-hardening with SeSecurityPrivilege unless the process is elevated.
const decode = `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim()))`;
const scripts = {
  acl: `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${decode}|ConvertFrom-Json; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $d=[System.IO.DirectoryInfo]::new($v.path); $acl=$d.GetAccessControl(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){ [void]$acl.RemoveAccessRuleAll($rule) }; foreach($id in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){ $r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r) }; $d.SetAccessControl($acl)`,
  // Per-file tamper check: the owner must be this user and every Allow ACE must resolve to
  // this user or SYSTEM, so a same-user swap granting other principals read fails closed.
  check: `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${decode}|ConvertFrom-Json; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $f=[System.IO.FileInfo]::new($v.path); $acl=$f.GetAccessControl(); if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'owner'}; foreach($r in @($acl.Access)){ if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')){throw 'permissions'} }`,
  protect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ${decode}; $b=[Text.Encoding]::UTF8.GetBytes($v); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`,
  unprotect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ${decode}; $b=[Convert]::FromBase64String($v); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`
};
const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

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
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershellScript(script), 'utf16le').toString('base64')], { env: powershellEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    // 'close' waits for stdout/stderr to drain; 'exit' can fire while output is pending.
    child.on('close', code => finish(code === 0 ? undefined : failed()));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

/** A fresh round-trip distinguishes a corrupt blob from a blocked or timed-out helper. */
async function dpapiUsable(): Promise<boolean> {
  const canary = randomBytes(16).toString('hex');
  try {
    const protectedValue = await windowsHelper(scripts.protect, encode(canary));
    return await windowsHelper(scripts.unprotect, encode(protectedValue)) === canary;
  } catch { return false; }
}

export async function hardenHome(paths: ManagedPaths): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const info = await lstat(paths.home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed home must be a real directory');
  // `--home` is user input. Hardening removes inheritance and every foreign ACE, so never
  // apply it to an unrelated non-empty directory; the marker records that we own this one.
  const marker = join(paths.home, '.grok-agent-bridge-home');
  let marked = false;
  try { const entry = await lstat(marker); marked = entry.isFile() && !entry.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!marked) {
    if ((await readdir(paths.home)).length > 0) throw new Error('Refusing to harden a non-empty directory that is not a managed bridge home');
    await writeFile(marker, 'managed by grok-agent-bridge\n', { mode: 0o600 });
  }
  if (process.platform === 'win32') await windowsHelper(scripts.acl, encode(JSON.stringify({ path: paths.home })));
  else await chmod(paths.home, 0o700);
}

export async function readCredential(paths: ManagedPaths): Promise<string> {
  const info = await lstat(paths.token);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid managed credential file');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Managed credential permissions must be private');
  if (process.platform === 'win32') {
    // lstat cannot see a swapped file whose ACL grants other principals read. Fail closed as
    // invalid so ensureCredential's rotation path replaces the tampered credential.
    try { await windowsHelper(scripts.check, encode(JSON.stringify({ path: paths.token }))); }
    catch { throw new Error('Invalid managed credential'); }
  }
  const value = await readFile(paths.token, 'utf8');
  const prefix = 'grok-bridge-dpapi-v1\n';
  let token = value;
  if (process.platform === 'win32') {
    if (!value.startsWith(prefix)) token = '';
    else {
      try { token = await windowsHelper(scripts.unprotect, encode(value.slice(prefix.length))); }
      catch (error) {
        // A blob protected under another profile/key, or one damaged by an interrupted write, is
        // corruption rather than a machine failure. Only rotate when DPAPI itself still works;
        // a blocked, missing, or timed-out helper must leave a known-good credential untouched.
        if (await dpapiUsable()) throw new Error('Invalid managed credential');
        throw error;
      }
    }
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid managed credential');
  return token;
}

export async function ensureCredential(paths: ManagedPaths): Promise<string> {
  await hardenHome(paths);
  let invalid = false;
  try { return await readCredential(paths); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && /^Invalid managed credential( file)?$/.test(error.message)) invalid = true;
      else throw error;
    }
  }
  // Create the replacement before moving the old file aside. If protection fails, a
  // known-good credential is not left missing just because a later step could not run.
  const token = randomBytes(32).toString('hex');
  const stored = process.platform === 'win32' ? `grok-bridge-dpapi-v1\n${await windowsHelper(scripts.protect, encode(token))}` : token;
  const temporary = paths.token + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, stored, { flag: 'wx', mode: 0o600 });
    if (invalid) {
      try { await rename(paths.token, `${paths.token}.invalid-${Date.now()}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await link(temporary, paths.token); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Hard links are unavailable on some filesystems; rename is atomic within the
        // owner-only home. Never overwrite: a concurrent rotation may already have
        // published a valid credential, and the final read below returns it.
        let absent = false;
        try { await lstat(paths.token); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; absent = true; }
        if (absent) await rename(temporary, paths.token);
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
  return readCredential(paths);
}
