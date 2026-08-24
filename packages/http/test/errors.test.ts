import { describe as suite, expect, it } from 'vitest';
import { classifyResponse, classifyThrown } from '../src/errors';

suite('classifyResponse', () => {
  it('maps status codes onto remedies, not onto jargon', () => {
    expect(classifyResponse(401)).toEqual({ kind: 'auth', status: 401 });
    expect(classifyResponse(404)).toEqual({ kind: 'not_found' });
    expect(classifyResponse(413)).toEqual({ kind: 'too_large' });
    expect(classifyResponse(503)).toEqual({ kind: 'server_error', status: 503 });
  });

  it('honours Retry-After when Paperless sends one', () => {
    expect(classifyResponse(429, '', '120')).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 120_000,
    });
    expect(classifyResponse(429)).toEqual({ kind: 'rate_limited' });
  });

  it('never retries a certificate problem', () => {
    expect(classifyThrown(new Error('self signed certificate')).kind).toBe('tls');
    expect(classifyThrown(new Error('network request failed')).kind).toBe('unreachable');
  });
});

suite('classifyResponse edge cases', () => {
  it('treats a request timeout as unreachable, not as a refusal', () => {
    expect(classifyResponse(408)).toEqual({ kind: 'unreachable' });
  });

  it('ignores a Retry-After it cannot parse', () => {
    expect(classifyResponse(429, '', 'Wed, 21 Oct 2026 07:28:00 GMT')).toEqual({
      kind: 'rate_limited',
    });
  });

  it('keeps a bounded slice of the body for the advanced disclosure', () => {
    const reason = classifyResponse(400, 'x'.repeat(900));
    expect(reason).toEqual({ kind: 'rejected', status: 400, message: 'x'.repeat(500) });
  });
});
