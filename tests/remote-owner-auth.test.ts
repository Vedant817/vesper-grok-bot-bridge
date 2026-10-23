import { describe, expect, it, vi } from 'vitest';
import { ownerMacKey } from '../src/remote/key-derivation.js';
import { signOwnerRequest, verifyOwnerRequest } from '../src/remote/owner-auth.js';

describe('private local owner proofs', () => {
  const secret = 'c'.repeat(64), operation = { method: 'POST', path: '/owner/approve', body: { id: 'a'.repeat(32) } };
  it('never transmits the owner credential and binds each single-use proof to its operation', () => {
    const headers = signOwnerRequest(ownerMacKey(secret), operation), used = new Set<string>();
    expect(JSON.stringify(headers)).not.toContain(secret);
    expect(verifyOwnerRequest(secret, { ...operation, path: '/owner/revoke-client', headers }, used)).toBe(false);
    expect(verifyOwnerRequest(secret, { ...operation, method: 'GET', headers }, used)).toBe(false);
    expect(verifyOwnerRequest(secret, { ...operation, body: { id: 'b'.repeat(32) }, headers }, used)).toBe(false);
    expect(verifyOwnerRequest('d'.repeat(64), { ...operation, headers }, used)).toBe(false);
    expect(verifyOwnerRequest(secret, { ...operation, headers }, used)).toBe(true);
    expect(verifyOwnerRequest(secret, { ...operation, headers }, used)).toBe(false);
  });
  it('rejects expired and future proofs and bounds retained valid nonces', () => {
    const at = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const headers = signOwnerRequest(ownerMacKey(secret), operation), used = new Set<string>();
      clock.mockReturnValue(at + 10001); expect(verifyOwnerRequest(secret, { ...operation, headers }, used)).toBe(false);
      clock.mockReturnValue(at - 10001); expect(verifyOwnerRequest(secret, { ...operation, headers }, used)).toBe(false);
      clock.mockReturnValue(at);
      for (let i = 0; i < 1024; i++) expect(verifyOwnerRequest(secret, { ...operation, headers: signOwnerRequest(ownerMacKey(secret), operation) }, used)).toBe(true);
      expect(verifyOwnerRequest(secret, { ...operation, headers: signOwnerRequest(ownerMacKey(secret), operation) }, used)).toBe(false);
      expect(used.size).toBe(1024);
      clock.mockReturnValue(at + 10001);
      expect(verifyOwnerRequest(secret, { ...operation, headers: signOwnerRequest(ownerMacKey(secret), operation) }, used)).toBe(true);
      expect(used.size).toBe(1);
    } finally { clock.mockRestore(); }
  });
});
