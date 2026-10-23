import { beforeEach, expect, it, vi } from 'vitest';
import { PtyWorker } from '../src/adapters/pty.js';
import { Redactor } from '../src/safety.js';

const native = vi.hoisted(() => ({
  data: undefined as ((text: string) => void) | undefined,
  exit: undefined as ((event: { exitCode: number }) => void) | undefined,
  kill: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: () => ({
  onData: (callback: typeof native.data) => { native.data = callback; },
  onExit: (callback: typeof native.exit) => { native.exit = callback; },
  kill: native.kill,
}) }));
beforeEach(() => { native.kill.mockReset(); native.data = undefined; native.exit = undefined; });

it('kills once across an interactive prompt, late output and repeated cleanup', async () => {
  native.kill.mockImplementation(() => { if (native.kill.mock.calls.length > 1) throw new Error('Native process was killed twice'); });
  const worker = new PtyWorker(process.execPath, [], new Redactor());
  await worker.start(process.cwd(), 'task');
  native.data?.('Approve execution? [y/n]');
  expect(await worker.next(AbortSignal.timeout(1000))).toMatchObject({ type: 'failed', error: expect.stringContaining('Interactive') });
  native.data?.('Approve execution? [y/n]');
  await Promise.all([worker.cancel(), worker.close(), worker.close()]);
  expect(native.kill).toHaveBeenCalledTimes(1);
});

it('does not kill a native process after its exit notification', async () => {
  const worker = new PtyWorker(process.execPath, [], new Redactor());
  await worker.start(process.cwd(), 'task');
  native.exit?.({ exitCode: 0 });
  expect(await worker.next(AbortSignal.timeout(1000))).toMatchObject({ type: 'completed' });
  await worker.cancel(); await worker.close();
  expect(native.kill).not.toHaveBeenCalled();
});
