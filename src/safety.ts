import { relative, isAbsolute, resolve } from 'node:path';

export type Risk = 'safe' | 'guarded' | 'blocked';
export interface Permission { command?: string; executable?: string; args?: string[]; cwd?: string; description?: string }
export interface Verdict { risk: Risk; allow: boolean; reason: string; alternative?: string }

/** Only structured, narrowly known reads are eligible for unattended approval.
 * Shell text is never parsed into an allegedly safe argv. This is policy, not an OS sandbox. */
export function classifyPermission(request: Permission, root: string): Verdict {
  const deny = (risk: Risk, reason: string): Verdict => ({ risk, allow: false, reason, alternative: 'Use a scoped structured operation inside the task worktree.' });
  if (!request.cwd || !within(root, request.cwd)) return deny('blocked', 'Missing or out-of-worktree cwd');
  const text = [request.command, request.executable, ...(request.args ?? []), request.description].filter(Boolean).join(' ');
  if (/(?:\.ssh|\.aws|\.gnupg|credentials|id_rsa|\.env|\/etc\/|[a-z]:\\windows)|(?:\brm\b|\brmdir\b|remove-item|\bdel\b|\bdrop\s+(?:table|database)\b)|(?:\bgit\b.*(?:--force|\s-f\b|reset\s+--hard|clean\s+-))|(?:curl|wget|invoke-webrequest).*\|/i.test(text)) return deny('blocked', 'Destructive or credential-sensitive request');
  if (!request.executable || request.command) return deny('guarded', 'Unstructured shell commands require explicit policy');
  const args = request.args ?? [];
  if (args.some(a => /[\x00-\x1f;&|<>`$!*?]/.test(a) || a.startsWith('-C') || a.startsWith('--git-dir') || a.startsWith('--work-tree') || a.includes('..') || isAbsolute(a))) return deny('guarded', 'Ambiguous argument or path');
  const key = JSON.stringify(args);
  if (request.executable === 'git' && [['status', '--short'], ['status', '--porcelain'], ['diff', '--stat'], ['diff', '--numstat'], ['rev-parse', 'HEAD'], ['log', '-1', '--oneline']].some(a => JSON.stringify(a) === key)) return { risk: 'safe', allow: true, reason: 'Known read-only git operation' };
  return deny('guarded', 'Operation is outside the read-only allowlist');
}

export function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class Redactor {
  constructor(private readonly secrets: readonly string[] = []) {}
  json(value: unknown): string {
    const text = JSON.stringify(value, (_key, item) => typeof item === 'string' ? this.redact(item) : item);
    if (text === undefined) throw new Error('A JSON value is required');
    return text;
  }
  redact(input: string): string {
    let text = input;
    for (const secret of [...this.secrets.flatMap(s => [s, ...s.split(/\r?\n/)])].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:sk-|xai-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/(bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
  }
}

/** Buffer a bounded record rather than emit partial secrets across stream chunks. */
export class RedactedRecords {
  private buffer = '';
  private dropping = false;
  private privateKey = false;
  private overflowed = false;
  constructor(private readonly redactor: Redactor, private readonly maxRecord = 65536) {}
  push(chunk: string): string[] {
    const lines = (this.buffer + chunk).split('\n');
    this.buffer = lines.pop()!;
    const output: string[] = [];
    for (const line of lines) {
      const startsKey = /-----BEGIN [^-]*PRIVATE KEY-----/.test(line);
      const endsKey = /-----END [^-]*PRIVATE KEY-----/.test(line);
      output.push(this.overflowed || this.dropping || line.length > this.maxRecord ? '[OVERSIZED RECORD REDACTED]' : this.privateKey || startsKey ? '[REDACTED PRIVATE KEY]' : this.redactor.redact(line));
      if (startsKey) this.privateKey = true;
      if (endsKey) this.privateKey = false;
      this.dropping = false;
    }
    if (this.buffer.length > this.maxRecord) { this.buffer = ''; this.dropping = true; this.overflowed = true; }
    return output;
  }
  end(): string { const result = this.overflowed || this.dropping ? '[OVERSIZED RECORD REDACTED]' : this.privateKey ? '[REDACTED PRIVATE KEY]' : this.redactor.redact(this.buffer); this.buffer = ''; this.dropping = false; this.privateKey = false; this.overflowed = false; return result; }
}
