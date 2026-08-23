import type { FailureReason } from '@sheaf/core';

/**
 * Map an HTTP response onto a reason the rest of the system understands.
 * Pure, so every branch is unit-tested without a server.
 */
export function classifyResponse(status: number, body = '', retryAfter?: string): FailureReason {
  if (status === 401 || status === 403) return { kind: 'auth', status };
  if (status === 404) return { kind: 'not_found' };
  if (status === 408) return { kind: 'unreachable' };
  if (status === 413) return { kind: 'too_large' };
  if (status === 429) {
    const ms = parseRetryAfter(retryAfter);
    return ms === null ? { kind: 'rate_limited' } : { kind: 'rate_limited', retryAfterMs: ms };
  }
  if (status >= 500) return { kind: 'server_error', status };
  return { kind: 'rejected', status, message: body.slice(0, 500) };
}

/** Map a thrown fetch error. TLS problems must never be retried blindly. */
export function classifyThrown(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/certificate|self.signed|tls|ssl|hostname mismatch/i.test(message)) {
    return { kind: 'tls', detail: message.slice(0, 500) };
  }
  return { kind: 'unreachable' };
}

function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  return null;
}
