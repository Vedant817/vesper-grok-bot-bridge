import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRemoteTunnel } from '../src/remote/tunnel.js';
let home: string;
const active: { close(): Promise<void> }[] = [];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'remote-tunnel-')); });
afterEach(async () => { await Promise.all(active.splice(0).map(tunnel => tunnel.close())); await rm(home, { recursive: true, force: true }); });
const config = (args: string[]) => ({ origin: 'https://example.ngrok.app', port: 18771, tunnel: { command: process.execPath, args } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
it('launches directly with literal argument boundaries and closes its owned native tree idempotently', async () => {
  const fixture = join(home, 'fixture.cjs'), report = join(home, 'report.json');
  await writeFile(fixture, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,child:child.pid,args:process.argv.slice(3)})); setInterval(()=>{},1000);`);
  const args = ['a b', 'x&y', 'literal"quote', '$(not-shell)', '%not-shell%'];
  const tunnel = await startRemoteTunnel(config([fixture, report, ...args])); active.push(tunnel);
  const result = JSON.parse(await readFile(report, 'utf8'));
  expect(result.args).toEqual(args); expect(alive(result.pid)).toBe(true); expect(alive(result.child)).toBe(true);
  await Promise.all([tunnel.close(), tunnel.close()]);
  expect(alive(result.pid)).toBe(false);
  expect(alive(result.child)).toBe(false);
}, 15000);
it('rejects immediate failure with a generic diagnostic instead of forwarding process output', async () => {
  await expect(startRemoteTunnel(config(['-e', 'console.error("secret-should-not-appear");process.exit(42)']))).rejects.toThrow('Remote tunnel failed during startup');
});
it('rejects missing executables, directories, relative commands and shell launchers', async () => {
  for (const command of [join(home, 'missing.exe'), home, 'ngrok']) {
    await expect(startRemoteTunnel({ ...config([]), tunnel: { command, args: [] } })).rejects.toThrow();
  }
  if (process.platform === 'win32') {
    const script = join(home, 'tunnel.cmd'); await writeFile(script, '@echo off');
    await expect(startRemoteTunnel({ ...config([]), tunnel: { command: script, args: [] } })).rejects.toThrow('native executable');
  }
});
it('requires an explicitly configured tunnel', async () => {
  await expect(startRemoteTunnel({ origin: 'https://example.ngrok.app', port: 18771 })).rejects.toThrow('configuration is required');
});
