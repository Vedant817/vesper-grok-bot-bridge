import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeService } from '../src/bridge/service.js';
import { TaskRouter } from '../src/bridge/router.js';
import { AsyncQueue } from '../src/rpc.js';
import { git } from '../src/worktree.js';
import type { Worker, WorkerEvent } from '../src/contracts.js';

it.each(['start', 'continue'] as const)('retains mutation ownership after a real process exit during %s', async kind => {
  const base = await mkdtemp(join(tmpdir(), 'bridge-crash-')), directory = join(base, 'repo'), stateDirectory = join(base, 'state'), log = join(base, 'submitted.jsonl');
  let bridge: BridgeService | undefined;
  try {
    await mkdir(directory); await git(directory, ['init']); await git(directory, ['config', 'user.name', 'Crash fixture']); await git(directory, ['config', 'user.email', 'fixture@example.test']);
    await writeFile(join(directory, 'source.txt'), 'fixture'); await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'fixture']);
    const config = { stateDirectory, roots: [{ directory, verify: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] };
    const input = { taskKey: 'one-task', requestId: 'initial', provider: 'fixture', model: 'exact', directory, instruction: 'Initial instruction' };
    const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(resolve(file)).href);
    const script = join(base, 'crash.mjs');
    await writeFile(script, `
import {appendFileSync} from 'node:fs';
import {BridgeService} from ${moduleUrl('src/bridge/service.ts')};
import {TaskRouter} from ${moduleUrl('src/bridge/router.ts')};
import {AsyncQueue} from ${moduleUrl('src/rpc.ts')};
const kind=${JSON.stringify(kind)}, log=${JSON.stringify(log)}, input=${JSON.stringify(input)};
const queue=new AsyncQueue();
const worker={nativeSessionId:'native-owned',async start(){appendFileSync(log,JSON.stringify({kind:'start'})+'\\n');if(kind==='start')process.exit(87);queue.push({type:'completed',summary:'First turn complete'});},next(signal){return queue.next(signal)},async respond(){},async steer(task){appendFileSync(log,JSON.stringify({kind:'continue',task})+'\\n');process.exit(88)},async cancel(){},async close(){queue.close()}};
const bridge=await BridgeService.create(${JSON.stringify(config)},[{id:'fixture',label:'Fixture',models:['exact'],available:true,create(){return worker}}]);
const router=await TaskRouter.create(bridge,${JSON.stringify(stateDirectory)});
const first=await router.dispatch(input);
await bridge.wait(first.session.id,0,30000);
await router.dispatch({...input,requestId:'continuation',instruction:'Apply one-time migration'});
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, script], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(kind === 'start' ? 87 : 88);
    let replacementStarts = 0; const queue = new AsyncQueue<WorkerEvent>();
    const worker: Worker = { nativeSessionId: 'native-owned', async start() { replacementStarts++; }, next: signal => queue.next(signal), async respond() {}, async steer() {}, async cancel() {}, async close() { queue.close(); } };
    bridge = await BridgeService.create(config, [{ id: 'fixture', label: 'Fixture', models: ['exact'], available: true, create: () => worker }]);
    const router = await TaskRouter.create(bridge, stateDirectory), retained = bridge.list()[0];
    expect(retained.nativeId ?? (kind === 'start' ? 'not-yet-acknowledged' : undefined)).toBe(kind === 'start' ? 'not-yet-acknowledged' : 'native-owned');
    await expect(router.dispatch({ ...input, requestId: 'fresh-bypass', instruction: 'Apply one-time migration' })).rejects.toThrow('uncertain');
    await expect(router.dispatch({ ...input, taskKey: 'alias', requestId: 'alias-bypass', sessionId: retained.id, instruction: 'Apply one-time migration' })).rejects.toThrow('uncertain');
    await expect(bridge.resume(retained.id, 'Apply one-time migration')).rejects.toThrow('uncertain');
    await expect(bridge.followup(retained.id, 'Apply one-time migration')).rejects.toThrow('uncertain');
    expect(replacementStarts).toBe(0);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(kind === 'start' ? 1 : 2);
  } finally { await bridge?.close(); await rm(base, { recursive: true, force: true }); }
}, 30000);
