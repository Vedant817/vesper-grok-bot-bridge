import { describe, expect, it } from 'vitest';
import { StdioWire } from '../src/rpc.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

describe('owned stdio process lifecycle', () => {
  it('closes inherited pipes and stops its live child tree idempotently', async () => {
    const script = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{pid:child.pid}}));setInterval(()=>{},1000);`;
    const wire = new StdioWire(process.execPath, ['-e', script], process.cwd());
    let childPid: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not start')), 5000);
        wire.onMessage = message => { childPid = (message.params as { pid: number }).pid; clearTimeout(timer); resolve(); };
        wire.onClose = error => { clearTimeout(timer); reject(error); };
      });
      wire.close(); wire.close();
      expect(wire.process.stdin.destroyed).toBe(true);
      expect(wire.process.stdout.destroyed).toBe(true);
      expect(wire.process.stderr.destroyed).toBe(true);
      await until(() => !alive(wire.process.pid!) && !alive(childPid!));
    } finally {
      wire.close();
      if (childPid && alive(childPid)) process.kill(childPid);
    }
  }, 15000);

  it('can release streams after the direct child already exited', async () => {
    const wire = new StdioWire(process.execPath, ['-e', 'process.exit(0)'], process.cwd());
    await until(() => wire.process.exitCode !== null);
    wire.close(); wire.close();
    expect(wire.process.stdout.destroyed).toBe(true);
    expect(wire.process.stderr.destroyed).toBe(true);
  });
});
