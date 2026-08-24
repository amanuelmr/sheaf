import { classifyResponse, err, ok, type ApiResult } from '@sheaf/http';
import type { PutOutcome } from '@sheaf/protocol';

/**
 * What a `PUT` status code means.
 *
 * Exported and pure because there are two upload paths that must agree exactly:
 * the ordinary `fetch` in this package, and the platform's streaming file upload on
 * a phone, which never goes through `fetch` at all. One function, so they cannot
 * drift into disagreeing about whether an upload succeeded.
 */
export function interpretPutStatus(status: number, body = ''): ApiResult<PutOutcome> {
  // Both are success. The only difference is who stored it, which matters for
  // reporting and nothing else -- and this is precisely the case that used to
  // require reading a duplicate-detection message.
  if (status === 201) return ok('stored');
  if (status === 200) return ok('already-stored');
  return err(classifyResponse(status, body));
}
