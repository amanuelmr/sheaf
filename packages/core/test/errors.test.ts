import { describe as suite, expect, it } from 'vitest';
import { describe as explain, isBlocking, isRetryable } from '../src/errors';
import type { FailureReason } from '../src/events';

const ALL: FailureReason[] = [
  { kind: 'unreachable' },
  { kind: 'server_error', status: 503 },
  { kind: 'rate_limited' },
  { kind: 'auth', status: 401 },
  { kind: 'not_found' },
  { kind: 'tls', detail: 'hostname mismatch' },
  { kind: 'too_large' },
  { kind: 'rejected', status: 400, message: 'unsupported file type' },
];

suite('user-facing errors', () => {
  it('answers all three questions for every failure mode', () => {
    for (const reason of ALL) {
      const e = explain(reason);
      expect(e.title.length).toBeGreaterThan(0);
      // "Is my document safe?" is never left unanswered.
      expect(e.reassurance).toMatch(/safe on this device/);
      expect(e.actions.length).toBeGreaterThan(0);
      expect(e.technical.length).toBeGreaterThan(0);
    }
  });

  it('never leads with a status code', () => {
    for (const reason of ALL) {
      expect(explain(reason).title).not.toMatch(/\b[45]\d\d\b/);
      expect(explain(reason).title).not.toMatch(/HTTP/i);
    }
  });

  it('keeps the technical detail available for the advanced disclosure', () => {
    expect(explain({ kind: 'auth', status: 403 }).technical).toBe('HTTP 403');
  });

  it('classifies remedies as time, user, or neither', () => {
    expect(isRetryable({ kind: 'unreachable' })).toBe(true);
    expect(isRetryable({ kind: 'auth', status: 401 })).toBe(false);
    expect(isBlocking({ kind: 'tls', detail: 'x' })).toBe(true);
    expect(isBlocking({ kind: 'server_error', status: 500 })).toBe(false);
  });

  it('offers a token fix for auth and a server fix for a wrong URL', () => {
    expect(explain({ kind: 'auth', status: 401 }).actions).toContain('check_token');
    expect(explain({ kind: 'not_found' }).actions).toContain('check_server_settings');
  });
});
