import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDesktopLauncher } from '../src/connect/launcher.js';
let base: string, command: string, archive: string, entrypoint: string, shim: string;
const source = (exe = command, entry = entrypoint) => `@echo off\r\nrem Written by T3 Code: runs the desktop app's bundled t3 CLI.\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${exe}" "${entry}" %*\r\n`;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 't3-launcher-')); await mkdir(join(base, 'resources'));
  command = join(base, 'T3 Code (Nightly).exe'); archive = join(base, 'resources', 'server.asar');
  entrypoint = join(archive, 'apps', 'server', 'dist', 'bin.mjs'); shim = join(base, 't3.cmd');
  await writeFile(command, 'native executable fixture'); await writeFile(archive, 'archive fixture'); await writeFile(shim, source());
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
it('discovers the desktop native prefix from public data without executing it', async () => {
  expect(await readDesktopLauncher(shim)).toEqual({ command, args: [entrypoint] });
});
it('accepts stable T3 Desktop as well as Nightly and ordinary LF endings', async () => {
  const stable = join(base, 'T3 Code.exe'); await writeFile(stable, 'fixture'); await writeFile(shim, source(stable).replaceAll('\r\n', '\n'));
  expect(await readDesktopLauncher(shim)).toEqual({ command: stable, args: [entrypoint] });
});
it('rejects ambiguous commands, extra arguments, and substituted binaries or archives', async () => {
  for (const text of [source() + source(), source() + `"${command}" "${entrypoint}" --inspect %*\r\n`, source() + `call "${command}"\r\n`, source() + `start "" "${command}"\r\n`, source().replace(' %*', ' --other %*'), source(join(base, 'other.exe')), source(command, join(base, 'other.mjs')), source().replace('ELECTRON_RUN_AS_NODE=1', 'ELECTRON_RUN_AS_NODE=0'), source().replace('Written by T3 Code', 'Written by another app')]) {
    await writeFile(shim, text); expect(await readDesktopLauncher(shim)).toBeUndefined();
  }
});
it.skipIf(process.platform !== 'win32')('normalizes valid Windows casing before launching the canonical .mjs entrypoint', async () => {
  await writeFile(shim, source(command.toUpperCase(), entrypoint.toUpperCase()));
  expect(await readDesktopLauncher(shim)).toEqual({ command: command.toUpperCase(), args: [join(base.toUpperCase(), 'resources', 'server.asar', 'apps', 'server', 'dist', 'bin.mjs')] });
});
it('refuses relative locations, shell command suffixes, missing files and oversized shims', async () => {
  for (const text of [source('T3 Code.exe'), source(command, 'bin.mjs'), source().replace(' %*', ' %* & echo extra'), source() + 'x'.repeat(16384)]) {
    await writeFile(shim, text); expect(await readDesktopLauncher(shim)).toBeUndefined();
  }
  await writeFile(shim, source()); await rm(archive); expect(await readDesktopLauncher(shim)).toBeUndefined();
  expect(await readDesktopLauncher(join(base, 'missing.cmd'))).toBeUndefined();
});
it('rejects a directory standing in for the public shim', async () => {
  expect(await readDesktopLauncher(base)).toBeUndefined();
});
it('rejects a symlink standing in for the public shim', async ({ skip }) => {
  const link = join(base, 'linked.cmd');
  try { await symlink(shim, link, 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return; } throw error; }
  expect(await readDesktopLauncher(link)).toBeUndefined();
});
