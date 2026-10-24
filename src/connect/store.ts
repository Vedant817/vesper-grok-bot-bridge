import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hardenHome } from '../managed/credentials.js';
import { managedPaths } from '../managed/paths.js';
import { powershellEnvironment, powershellPath, powershellScript } from '../managed/powershell.js';
import { connectEndpoint } from './security.js';

const recordSchema = z.object({
  version: z.literal(1), endpoint: z.string(), accessToken: z.string().min(1).max(32768),
  expiresAt: z.number().finite().positive(), enrolledAt: z.number().finite().positive(),
  clientInformation: z.record(z.string(), z.unknown()), rejected: z.boolean().optional()
});
export type ConnectCredential = z.infer<typeof recordSchema>;
/** Injectable store supports fixtures without touching installed per-user credentials. */
export interface ConnectCredentialStore {
  read(ref: string): Promise<ConnectCredential | undefined>;
  write(ref: string, record: ConnectCredential): Promise<void>;
}
export function credentialReference(endpoint: string): string {
  return createHash('sha256').update(connectEndpoint(endpoint).href).digest('hex');
}
const decode = '$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim()));';
const scripts = {
  own: `${decode} $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $file=[System.IO.FileInfo]::new($v); $acl=$file.GetAccessControl(); $acl.SetOwner($sid); $file.SetAccessControl($acl)`,
  protect: `${decode} Add-Type -AssemblyName System.Security; [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`,
  unprotect: `${decode} Add-Type -AssemblyName System.Security; [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`,
  check: `${decode} $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath $v; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'owner'}; foreach($r in $acl.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')){throw 'permissions'}}`
};
/** Generic UTF-8 record protection, unlike the managed daemon's fixed hex bearer format. */
async function windowsRecord(operation: keyof typeof scripts, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${scripts[operation]}`;
    const prepared = powershellScript(script, operation === 'check' ? ['Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security'] : ['Microsoft.PowerShell.Utility']);
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prepared, 'utf16le').toString('base64')], {
      windowsHide: true, env: powershellEnvironment(), stdio: ['pipe', 'pipe', 'ignore']
    });
    let output = '', settled = false;
    const finish = (ok: boolean, exitCode?: number | null) => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve(output) : reject(new Error(`Connect private credential operation failed (${operation}; exit ${exitCode ?? 'unknown'})`)); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 20000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 262144) { child.kill(); finish(false); } });
    child.on('error', () => finish(false)); child.on('close', code => finish(code === 0, code));
    child.stdin.on('error', () => {}); child.stdin.end(Buffer.from(value, 'utf8').toString('base64'));
  });
}
export class FileConnectCredentialStore implements ConnectCredentialStore {
  readonly home: string;
  constructor(home = join(managedPaths().home, 'connect')) { this.home = managedPaths(home).home; }
  private path(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid Connect credential reference');
    return join(this.home, `${ref}.json.enc`);
  }
  private async check(path: string, directory = false): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 262144)) throw new Error('Invalid Connect credential location');
    if (process.platform === 'win32') await windowsRecord('check', path);
    else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Connect credential location must be owner-only');
  }
  async read(ref: string): Promise<ConnectCredential | undefined> {
    const path = this.path(ref);
    try { await this.check(this.home, true); await this.check(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      let text = await readFile(path, 'utf8');
      if (process.platform === 'win32') {
        if (!text.startsWith('grok-connect-dpapi-v1\n')) throw new Error();
        text = Buffer.from(await windowsRecord('unprotect', text.slice('grok-connect-dpapi-v1\n'.length)), 'base64').toString('utf8');
      }
      const record = recordSchema.parse(JSON.parse(text));
      if (credentialReference(record.endpoint) !== ref) throw new Error();
      return record;
    } catch { throw new Error('Connect credential cannot be read; enroll again with this user profile'); }
  }
  async write(ref: string, value: ConnectCredential): Promise<void> {
    const path = this.path(ref);
    const record = recordSchema.parse(value);
    if (credentialReference(record.endpoint) !== ref) throw new Error('Connect credential endpoint mismatch');
    await hardenHome(managedPaths(this.home));
    await this.check(this.home, true);
    let data = JSON.stringify(record);
    if (process.platform === 'win32') data = `grok-connect-dpapi-v1\n${await windowsRecord('protect', data)}`;
    const temporary = join(this.home, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      // Elevated tokens can default new files to Administrators as owner. Keep the
      // strict per-user check by setting ownership on our fresh private file only.
      if (process.platform === 'win32') await windowsRecord('own', temporary);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
