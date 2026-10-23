import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ownerMacKey } from './key-derivation.js';

type OwnerRequest = { method: string; path: string; body?: unknown };
const value = (key: Buffer, request: OwnerRequest, nonce: string, at: string) => createHmac('sha256', key).update(JSON.stringify([
  'grok-remote-owner-v1', request.method, request.path,
  createHash('sha256').update(JSON.stringify(request.body ?? null)).digest('hex'), nonce, at
])).digest('hex');

/** Signs with the HKDF owner-MAC subkey; the raw master never reaches the wire or this HMAC. */
export function signOwnerRequest(key: Buffer, request: OwnerRequest): Record<string, string> {
  const nonce = randomBytes(16).toString('hex'), at = String(Date.now());
  return { 'x-bridge-owner-nonce': nonce, 'x-bridge-owner-at': at, 'x-bridge-owner-mac': value(key, request, nonce, at) };
}
export function verifyOwnerRequest(secret: string, request: OwnerRequest & { headers: Record<string, string | string[] | undefined> }, used: Set<string>): boolean {
  const nonce = request.headers['x-bridge-owner-nonce'], at = request.headers['x-bridge-owner-at'], mac = request.headers['x-bridge-owner-mac'];
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || typeof at !== 'string' || !/^\d{13}$/.test(at) || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) return false;
  if (Math.abs(Date.now() - Number(at)) > 10000) return false;
  // Prune unconditionally on every attempt, before the MAC, so failed probes still
  // reclaim capacity; entries are retained for their full validity window.
  for (const entry of used) if (Number(entry.split(':')[0]) < Date.now() - 10000) used.delete(entry);
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(value(ownerMacKey(secret), request, nonce, at), 'hex'))) return false;
  if ([...used].some(entry => entry.endsWith(`:${nonce}`)) || used.size >= 1024) return false;
  used.add(`${at}:${nonce}`); return true;
}
