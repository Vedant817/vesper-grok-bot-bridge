import { describe, expect, it } from 'vitest';
import { classifyPermission, Redactor } from '../src/safety.js';

describe('denylist coverage for credential-store and deletion bypasses', () => {
  const root = process.cwd();
  it.each([
    ['unlink', 'unlink ~/.ssh/known_hosts'],
    ['npmrc path', 'cat ~/.npmrc'],
    ['kube path', 'cp .kube/config /tmp/out'],
    ['docker path', 'cp .docker/config.json /tmp/out'],
    ['azure path', 'cat .azure/accessTokens.json'],
    ['gcloud path', 'cp .gcloud/credentials /tmp/out'],
    ['gh hosts path', 'cat .config/gh/hosts'],
    ['dsa key', 'cat ~/.ssh/id_dsa'],
    ['ed25519 key', 'cat id_ed25519'],
    ['ecdsa key', 'cat ~/.ssh/id_ecdsa'],
    ['8.3 short path', 'type C:\\WINDOWS~1\\notes.txt'],
    ['shred', 'shred secret.txt'],
    ['erase', 'erase secret.txt'],
    ['ri alias', 'ri C:\\temp\\secret.txt'],
    ['rd /s', 'rd /s C:\\temp'],
    ['rd /q', 'rd /q C:\\temp'],
  ])('blocks %s', (_label, command) => {
    expect(classifyPermission({ command, cwd: root }, root).risk).toBe('blocked');
  });
  it('blocks the find -delete deletion form', () => {
    expect(classifyPermission({ command: 'find . -name "*.log" -delete', cwd: root }, root).risk).toBe('blocked');
  });
  it('keeps the existing allowlist behavior', () => {
    expect(classifyPermission({ executable: 'git', args: ['status', '--short'], cwd: root }, root).risk).toBe('safe');
  });
});

describe('redaction closes the space-separated password evasion', () => {
  const redactor = new Redactor();
  it('redacts .netrc style passwords', () => {
    expect(redactor.redact('machine example.com login bob password supersecret9')).toBe('machine example.com login bob password [REDACTED]');
    expect(redactor.redact('password supersecret12 at line start')).toBe('password [REDACTED] at line start');
  });
  it('leaves prose like password manager readable', () => {
    const text = 'my password manager holds the rest';
    expect(redactor.redact(text)).toBe(text);
  });
});
