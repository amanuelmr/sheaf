import type { ErrorBody } from '@sheaf/protocol';
import { t } from './i18n';

/**
 * A failure as a person reads it: `message` says what happened and what to do, in
 * their language; `detail` keeps what the server or browser said, for whoever has
 * to look into it.
 */
export interface Failure {
  readonly ok: false;
  readonly message: string;
  readonly detail?: string;
}

const failure = (message: string, detail?: string): Failure =>
  detail === undefined || detail === '' ? { ok: false, message } : { ok: false, message, detail };

/** The server said no: its error code decides the sentence. */
export function failureFor(status: number, body: Partial<ErrorBody> | null): Failure {
  const detail = body?.detail;
  const technical = [body?.error ?? `HTTP ${String(status)}`, detail].filter(Boolean).join(': ');
  switch (body?.error ?? codeOf(status)) {
    case 'unauthenticated':
      return failure(t('Your sign-in has ended or the token is wrong. Sign in again.'), technical);
    case 'forbidden':
      return failure(t('You don’t have permission to do that.'), technical);
    case 'not_found':
      return failure(t('That isn’t there any more; it may have been deleted.'), technical);
    case 'too_large':
      return failure(t('That is too large for the server to take.'), technical);
    case 'rate_limited':
      return failure(t('Too many tries. Wait a few minutes, then try again.'), technical);
    case 'device_revoked':
      return failure(t('This device was removed from the server.'), technical);
    case 'pairing_invalid':
      return failure(t('That pairing code has run out or was used already.'), technical);
    case 'archive_disabled':
      return failure(t('Sending documents on isn’t set up on this server.'), technical);
    case 'released':
      return failure(t('This document was handed on and isn’t kept here any more.'), technical);
    case 'hash_mismatch':
      return failure(t('The file changed on its way to the server. Try again.'), technical);
    // Written for people: what clashed, or what to change.
    case 'conflict':
      return failure(
        detail === undefined ? t('That clashes with something already saved.') : detail,
        technical,
      );
    case 'bad_request':
    case 'malformed_id':
      return failure(
        detail === undefined
          ? t('The server didn’t accept that.')
          : t('The server didn’t accept that: {reason}', { reason: detail }),
        technical,
      );
    case 'server_error':
      return failure(
        body?.requestId === undefined
          ? t('Something went wrong on the server. Try again in a moment.')
          : t('Something went wrong on the server. Try again; the server log has it as {id}.', {
              id: body.requestId,
            }),
        technical,
      );
    case null:
      return failure(
        t('The server answered with an error ({status}).', { status: String(status) }),
        technical,
      );
  }
}

/** A refusal straight from `fetch`, whatever its body. */
export async function refused(response: Response): Promise<Failure> {
  let body: Partial<ErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<ErrorBody>;
  } catch {
    // Not JSON, perhaps not even Sheaf: the status alone has to do.
  }
  return failureFor(response.status, body);
}

/** Thrown on the way: the server was not reached, or what came back was not its. */
export function unreachable(error: unknown): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError) {
    return failure(
      t('The server sent an answer the app can’t read. Is this the Sheaf server’s address?'),
      detail,
    );
  }
  return failure(
    t('Couldn’t reach the server. Check the address and that the server is running.'),
    detail,
  );
}

function codeOf(status: number): ErrorBody['error'] | null {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status !== 503) return 'server_error';
  return null;
}
