import { spawn } from 'node:child_process';
import { powershellEnvironment, powershellPath } from '../dist/managed/powershell.js';

if (process.platform !== 'win32') process.exit(0);

// Only fixed public canaries are exchanged. Never print inherited environment or credentials.
const marker = 'helper-ready';
const probes = [
  ['startup', `[Console]::Out.Write('${marker}')`, false],
  ['encoded stdin', `[Console]::Out.Write([Console]::In.ReadToEnd())`, true],
  ['in-box modules', `Get-Command ConvertFrom-Json,Get-ScheduledTask -ErrorAction Stop | Out-Null; [Console]::Out.Write('${marker}')`, false],
];
let failed = false;
for (const [name, script, encoded] of probes) {
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', ...(encoded
      ? ['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
      : ['-Command', script])], { env: powershellEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = status => { if (settled) return; settled = true; clearTimeout(timer); resolve(status); };
    const timer = setTimeout(() => { child.kill(); finish('timed out'); }, 15000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish('spawn failed'));
    child.on('close', code => finish(code === 0 && output === marker ? 'passed' : 'failed'));
    child.stdin.end(encoded ? marker : '');
  });
  console.log(`Windows PowerShell ${name}: ${result} (${Date.now() - started}ms)`);
  if (result !== 'passed') failed = true;
}
if (failed) throw new Error('Windows PowerShell helper prerequisites failed; inspect the canary results above.');
