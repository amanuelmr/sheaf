/** A failure reads as a sentence a person can act on; the raw text is kept aside. */
import { describe as suite, expect, it } from 'vitest';
import { failureFor, refused, unreachable } from '../src/errors';

suite('failures in the web app', () => {
  it('says what to do instead of what the code calls it', () => {
    const failure = failureFor(401, { error: 'unauthenticated' });
    expect(failure.message).toBe('Your sign-in has ended or the token is wrong. Sign in again.');
    expect(failure.detail).toBe('unauthenticated');
  });

  it('keeps developer text out of the sentence, in the details', () => {
    const failure = failureFor(404, { error: 'not_found', detail: 'no such route GET /v1/x' });
    expect(failure.message).not.toContain('/v1/x');
    expect(failure.detail).toBe('not_found: no such route GET /v1/x');
  });

  it('shows a clash as the server words it, since it says what to change', () => {
    const failure = failureFor(409, { error: 'conflict', detail: 'ASN 12 is already used' });
    expect(failure.message).toBe('ASN 12 is already used');
  });

  it('names the logged error so it can be found', () => {
    const failure = failureFor(500, { error: 'server_error', requestId: 'abc-123' });
    expect(failure.message).toContain('abc-123');
  });

  it('reads the status when the answer is not the server’s JSON', async () => {
    const failure = await refused(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(failure.message).toBe('Something went wrong on the server. Try again in a moment.');
    expect(failure.detail).toBe('HTTP 502');
  });

  it('tells an unreachable server from an answer that is not Sheaf’s', () => {
    expect(unreachable(new TypeError('Failed to fetch'))).toEqual({
      ok: false,
      message: 'Couldn’t reach the server. Check the address and that the server is running.',
      detail: 'Failed to fetch',
    });
    expect(unreachable(new SyntaxError('Unexpected token <')).message).toContain(
      'Sheaf server’s address',
    );
  });
});
