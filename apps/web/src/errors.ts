import type { ErrorBody, ErrorCode } from '@sheaf/protocol';
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
  /** The server's error code, when it gave one or the status implies one. */
  readonly code?: ErrorCode;
}

const failure = (message: string, detail?: string, code?: ErrorCode | null): Failure => ({
  ok: false,
  message,
  ...(detail === undefined || detail === '' ? {} : { detail }),
  ...(code === undefined || code === null ? {} : { code }),
});

/** The server said no: its error code decides the sentence. */
export function failureFor(status: number, body: Partial<ErrorBody> | null): Failure {
  const detail = body?.detail;
  const technical = [body?.error ?? `HTTP ${String(status)}`, detail].filter(Boolean).join(': ');
  const code = body?.error ?? codeOf(status);
  const said = (message: string) => failure(message, technical, code);
  switch (code) {
    case 'unauthenticated':
      return said(t('Your sign-in has ended or the token is wrong. Sign in again.'));
    case 'forbidden':
      return said(t('You don’t have permission to do that.'));
    case 'not_found':
      return said(t('That isn’t there any more; it may have been deleted.'));
    case 'too_large':
      return said(t('That is too large for the server to take.'));
    case 'rate_limited':
      return said(t('Too many tries. Wait a few minutes, then try again.'));
    case 'device_revoked':
      return said(t('This device was removed from the server.'));
    case 'pairing_invalid':
      return said(t('That pairing code has run out or was used already.'));
    case 'archive_disabled':
      return said(t('Sending documents on isn’t set up on this server.'));
    case 'released':
      return said(t('This document was handed on and isn’t kept here any more.'));
    case 'hash_mismatch':
      return said(t('The file changed on its way to the server. Try again.'));
    // Written for people: what clashed, or what to change.
    case 'conflict':
      return said(detail === undefined ? t('That clashes with something already saved.') : detail);
    case 'bad_request':
    case 'malformed_id':
      return said(
        detail === undefined
          ? t('The server didn’t accept that.')
          : t('The server didn’t accept that: {reason}', { reason: detail }),
      );
    case 'server_error':
      return said(
        body?.requestId === undefined
          ? t('Something went wrong on the server. Try again in a moment.')
          : t('Something went wrong on the server. Try again; the server log has it as {id}.', {
              id: body.requestId,
            }),
      );
    case null:
      return said(t('The server answered with an error ({status}).', { status: String(status) }));
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

function codeOf(status: number): ErrorCode | null {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status !== 503) return 'server_error';
  return null;
}
