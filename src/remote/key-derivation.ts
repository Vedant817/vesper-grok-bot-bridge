import { hkdfSync } from 'node:crypto';

const subkey = (secret: string, info: string): Buffer => Buffer.from(hkdfSync('sha256', secret, new Uint8Array(0), info, 32));

/** The stored master remains the static bearer; HKDF separates each HMAC role from it. */
export const oauthSigningKey = (secret: string): Buffer => subkey(secret, 'grok-remote-oauth-v1');
export const ownerMacKey = (secret: string): Buffer => subkey(secret, 'grok-remote-owner-mac-v1');
