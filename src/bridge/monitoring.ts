import type { PendingRequest, SessionSnapshot, SessionStatus } from './types.js';

export type FailureClassification = 'auth' | 'rate_limit' | 'quota' | 'context' | 'transport' | 'policy' | 'unknown';

/** Diagnostic hints only. No classifier result authorizes a retry or account change. */
export function classifyFailure(message = ''): FailureClassification {
  if (/\b(?:quota|insufficient[_ ](?:quota|credits)|billing|usage limit|credit balance|subscription limit)\b/i.test(message)) return 'quota';
  if (/\b(?:429|rate[_ -]?limit(?:ed)?|too many requests|throttl\w*)\b/i.test(message)) return 'rate_limit';
  if (/\b(?:401|unauthorized|unauthenticated|authentication|invalid[_ -]?(?:api[_ -]?key|token)|not logged in|login required|sign in required|token expired)\b/i.test(message)) return 'auth';
  if (/\b(?:context (?:window|length|limit)|maximum context|too many tokens|token limit)\b/i.test(message)) return 'context';
  if (/\b(?:policy|content filter|safety refusal|permission denied|forbidden|403)\b/i.test(message)) return 'policy';
  if (/\b(?:transport|disconnect\w*|connection|econn\w*|socket|network|timed? ?out|timeout|broken pipe|eof)\b/i.test(message)) return 'transport';
  return 'unknown';
}

/** Conservative English secure-input boundary; this is a guard, not a language or legal guarantee. */
export function humanQuestionReason(question: string): string | undefined {
  const text = question.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/[_-]/g, ' ');
  if (/^(?:what is|what's|which is)\s+(?:the\s+)?(?:api key|password|access token)\s+(?:environment variable name|configuration field name)\s*\?$/i.test(text.trim())) return undefined;
  if (/^(?:(?:your|the)\s+)?(?:password|passphrase|api\s*key|mfa|otp|captcha|verification code)\s*[:?]?$/i.test(text.trim())) return 'A human must use the native secure-input handoff.';
  if (/\b(?:please\s+)?(?:log in|sign in|authenticate)\s+(?:to|with|using|through|via)\b/i.test(text)) return 'A human must complete the native authentication handoff.';
  const request = /\b(?:enter|provide|paste|type|supply|share|send|give|input|what is|what's|confirm|approve|authorize|accept|allow|complete|solve|verify|use|need|request)\b/i.test(text);
  if (!request) return undefined;
  if (/\b(?:password|passphrase|api\s*key|access token|refresh token|secret key|private key|recovery code|seed phrase)\b/i.test(text)) return 'Credentials require the native authentication handoff.';
  if (/\b(?:mfa|2fa|otp|captcha|one time (?:password|code)|verification code|authenticator code|security code)\b/i.test(text)) return 'A human must complete the native security challenge.';
  if (/\b(?:(?:log\s*in|sign\s*in|login|authentication)\s+(?:approval|request)|(?:approve|authorize|confirm|accept|allow)\b.{0,60}\b(?:log\s*in|sign\s*in|login))\b/i.test(text)) return 'A human must approve login through the native authentication handoff.';
  if (/\b(?:payment|purchase|charge|checkout|subscribe|subscription|billing consent)\b/i.test(text) && /\b(?:approve|authorize|confirm|consent|accept|allow|complete)\b/i.test(text)) return 'Payment consent requires the human account owner.';
  return undefined;
}

export function annotatePending(pending: PendingRequest): PendingRequest {
  const reason = pending.type === 'question' ? humanQuestionReason([pending.question, ...(pending.options ?? [])].join('\n')) : undefined;
  return reason ? { ...pending, requiresHuman: true, reason } : pending;
}

export interface SessionObservation {
  id: string; status: SessionStatus; cursor: number; pending: PendingRequest[];
  createdAt?: string; updatedAt?: string; lastActivityAt?: string;
  awaitingReview: boolean; recoveryRequired: boolean; failureClassification?: FailureClassification;
  stalledWarning: boolean; nextSuggestedAction: string;
}

export function observeSession(s: SessionSnapshot, connected: boolean, stallAfterMs: number, now = Date.now()): SessionObservation {
  const activity = s.lastActivityAt && Date.parse(s.lastActivityAt);
  const stalledWarning = ['starting', 'running'].includes(s.status) && typeof activity === 'number' && Number.isFinite(activity) && now - activity >= stallAfterMs;
  const recoveryRequired = s.status === 'interrupted' || (s.status === 'awaiting_review' && !connected);
  const pending = s.pending.map(annotatePending);
  let nextSuggestedAction = 'Wait for worker activity.';
  if (stalledWarning) nextSuggestedAction = 'Inspect worker health; inactivity is a warning, not a failure.';
  if (pending.length) nextSuggestedAction = pending.some(p => p.requiresHuman) ? 'Ask the human to complete the native secure-input or authentication handoff.' : 'Review pending input and respond explicitly.';
  else if (recoveryRequired) nextSuggestedAction = s.nativeId ? 'Explicitly resume the disconnected native session with a task.' : 'Inspect recovery state; no native session ID is available.';
  else if (s.status === 'awaiting_review') nextSuggestedAction = 'Review and verify the completed turn, or explicitly continue with a follow-up.';
  else if (s.status === 'failed') nextSuggestedAction = 'Inspect the diagnostic failure; resolve authentication or provider limits manually before any new task.';
  else if (['cancelled', 'finished'].includes(s.status)) nextSuggestedAction = 'No action required.';
  return { id: s.id, status: s.status, cursor: s.cursor, pending, createdAt: s.createdAt, updatedAt: s.updatedAt, lastActivityAt: s.lastActivityAt, awaitingReview: s.status === 'awaiting_review', recoveryRequired, failureClassification: s.status === 'failed' ? classifyFailure(s.error) : undefined, stalledWarning, nextSuggestedAction };
}
