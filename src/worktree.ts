import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { within } from './safety.js';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout.trim();
}
export async function createWorktree(repository: string, directory: string): Promise<string> {
  const repo = await realpath(repository);
  await mkdir(directory, { recursive: true });
  const base = await realpath(directory);
  if (within(repo, base)) throw new Error('Worktrees must live outside the source repository');
  const path = join(base, randomUUID());
  await git(repo, ['worktree', 'add', '--detach', path, 'HEAD']);
  return realpath(path);
}
export async function verifyWorktree(path: string): Promise<void> {
  const actual = await realpath(path);
  const top = await realpath(await git(actual, ['rev-parse', '--show-toplevel']));
  const gitDir = await realpath(await git(actual, ['rev-parse', '--absolute-git-dir']));
  const common = await git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (actual !== top || gitDir === await realpath(common)) throw new Error('An isolated linked git worktree root is required');
}
export interface ChangeSummary { status: string; entries: string[]; truncated: boolean; contentHash: string }
export async function changes(cwd: string): Promise<ChangeSummary> {
  const status = await git(cwd, ['status', '--porcelain=v1']);
  const entries = (await git(cwd, ['diff', '--numstat', 'HEAD'])).split('\n').filter(Boolean);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], { cwd, windowsHide: true, timeout: 30000 });
    child.stdout.on('data', chunk => hash.update(chunk)); child.stderr.resume(); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Diff hashing failed')));
  });
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const name of untracked.slice(0, 200)) {
    hash.update(name);
    const path = join(cwd, name); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) { hash.update('nonregular'); continue; }
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  }
  return { status: status.slice(0, 12000), entries: entries.slice(0, 200), truncated: status.length > 12000 || entries.length > 200 || untracked.length > 200, contentHash: hash.digest('hex') };
}
