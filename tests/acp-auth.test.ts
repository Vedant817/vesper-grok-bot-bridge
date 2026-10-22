import { describe, expect, it } from 'vitest';
import { AcpWorker } from '../src/adapters/acp.js';
import { bridgeOwnerSchema } from '../src/bridge/application.js';
import type { RpcMessage, Wire } from '../src/rpc.js';

class AuthWire implements Wire {
  messages: RpcMessage[] = []; onMessage?: (message: RpcMessage) => void; onClose?: (error: Error) => void;
  constructor(private mode: 'success' | 'rejected' | 'unadvertised') {}
  send(message: RpcMessage) {
    this.messages.push(message);
    if (message.id === undefined || !message.method) return;
    queueMicrotask(() => {
      const result = message.method === 'initialize' ? { protocolVersion: 1, authMethods: this.mode === 'unadvertised' ? [] : [{ id: 'cached_token' }] }
        : message.method === 'session/new' ? { sessionId: 'native' } : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
      this.onMessage?.(message.method === 'authenticate' && this.mode === 'rejected'
        ? { id: message.id, error: { code: -32000, message: 'Native login required' } } : { id: message.id, result });
    });
  }
  close() {}
}

describe('owner-selected ACP native authentication', () => {
  it('authenticates once before session creation and never on followup', async () => {
    const wire = new AuthWire('success'), worker = new AcpWorker(async () => wire, { authMethodId: 'cached_token' });
    try {
      await worker.start(process.cwd(), 'first');
      expect((await worker.next(AbortSignal.timeout(2000))).type).toBe('completed');
      await worker.steer('next'); expect((await worker.next(AbortSignal.timeout(2000))).type).toBe('completed');
      expect(wire.messages.filter(m => m.method).map(m => m.method)).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt', 'session/prompt']);
      expect(wire.messages.find(m => m.method === 'authenticate')?.params).toEqual({ methodId: 'cached_token' });
    } finally { await worker.close(); }
  });
  it.each(['rejected', 'unadvertised'] as const)('does not create or prompt a session after %s authentication', async mode => {
    const wire = new AuthWire(mode), worker = new AcpWorker(async () => wire, { authMethodId: 'cached_token' });
    try {
      await expect(worker.start(process.cwd(), 'first')).rejects.toThrow(mode === 'rejected' ? 'Native login required' : 'not advertised');
      expect(wire.messages.some(m => m.method === 'session/new' || m.method === 'session/prompt')).toBe(false);
      expect(wire.messages.filter(m => m.method === 'authenticate')).toHaveLength(mode === 'rejected' ? 1 : 0);
    } finally { await worker.close(); }
  });
  it('requires explicit ACP for owner-configured authentication', () => {
    const base = { stateDirectory: '/state', roots: [{ directory: '/repo', verify: { executable: 'node', args: [] } }] };
    expect(bridgeOwnerSchema.safeParse({ ...base, providers: { custom: { executable: 'native', protocol: 'acp', authMethodId: 'cached_token' } } }).success).toBe(true);
    expect(bridgeOwnerSchema.safeParse({ ...base, providers: { custom: { executable: 'native', protocol: 'codex', authMethodId: 'cached_token' } } }).success).toBe(false);
  });
});
