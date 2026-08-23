import type { FailureReason } from '@sheaf/core';

/**
 * Every call returns a result rather than throwing.
 *
 * A thrown error is easy to swallow; a value that must be destructured is not.
 * Failures come back as the same `FailureReason` the event log records, so there
 * is no translation layer between "the request failed" and "the document's log
 * says why".
 */
export type ApiResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: FailureReason };

export const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
export const err = <T>(reason: FailureReason): ApiResult<T> => ({ ok: false, reason });
