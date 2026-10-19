import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { application } from '../src/application.js';
import { configSchema } from '../src/config.js';
import { git } from '../src/worktree.js';
import { verifier } from '../src/verification.js';
import { Redactor } from '../src/safety.js';
import { PtyWorker } from '../src/adapters/pty.js';

it('runs repository -> fresh worktree -> real ACP child -> verifier -> retained evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-app-')), repository = join(base, 'repo'), state = join(base, 'state');
  try {
    await mkdir(repository); await git(repository, ['init']); await git(repository, ['config', 'user.email', 'test@example.invalid']); await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'seed.txt'), 'original'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'seed']);
    await writeFile(join(repository, 'human.txt'), 'uncommitted human work');
    const config = configSchema.parse({ repository, stateDirectory: state, adapter: 'acp', worker: { executable: process.execPath, args: [resolve('tests/fixtures/acp-agent.mjs')] }, verify: { executable: process.execPath, args: ['-e', "require('fs').accessSync('seed.txt'); console.log('Verifier passed')"] } });
    const app = await application(config, { answer: async () => 'TypeScript', evaluate: async () => ({ accept: true, feedback: 'Fixture verification passed' }) });
    const result = await app.run!('Inspect seed repository', AbortSignal.timeout(5000));
    expect(result.state).toBe('completed'); expect(result.worktree).not.toBe(repository);
    expect(await readFile(join(repository, 'human.txt'), 'utf8')).toBe('uncommitted human work');
    expect(await readdir(result.worktree)).not.toContain('human.txt');
    const runs = await readdir(join(state, 'runs')); const persisted = JSON.parse(await readFile(join(state, 'runs', runs[0], 'result.json'), 'utf8'));
    expect(persisted.state).toBe('completed'); expect((await readdir(join(state, 'runs', runs[0], 'cold'))).length).toBeGreaterThan(2);
  } finally { await rm(base, { recursive: true, force: true }); }
});
it('verifier refuses nonzero exit and redacts split output tokens', async () => {
  const verify = verifier(process.execPath, ['-e', "process.stdout.write('bearer top');setTimeout(()=>{console.log('secret');process.exit(3)},10)"], new Redactor(['topsecret']));
  const proof = await verify(process.cwd(), AbortSignal.timeout(2000));
  expect(proof.passed).toBe(false); expect(proof.output).not.toContain('topsecret'); expect(proof.output).toContain('[REDACTED]');
});
it('native PTY runs a process and stops on an interactive permission prompt', async () => {
  const worker = new PtyWorker(process.execPath, ['-e', "process.stdout.write('Approve execution? [y/n]');setInterval(()=>{},1000)"], new Redactor());
  try {
    await worker.start(process.cwd(), 'task');
    const event = await worker.next(AbortSignal.timeout(3000));
    expect(event.type).toBe('failed'); if (event.type === 'failed') expect(event.error).toContain('Interactive');
  } finally { await worker.close(); }
});
