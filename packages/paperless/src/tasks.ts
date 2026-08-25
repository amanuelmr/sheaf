import type { ServerOutcome } from '@sheaf/core';
import type { PaperlessTask } from './types.ts';

/**
 * Interpret a Paperless consumption task.
 *
 * The POST returning 200 means "accepted for consumption", NOT "stored" — the real
 * outcome arrives asynchronously here. Everything downstream depends on reading
 * this correctly, in particular:
 *
 * A duplicate rejection is a SUCCESS. Paperless hashes content itself and refuses
 * documents it already holds, so being told "duplicate" about bytes we chose to
 * upload proves the document is in Paperless. That is what makes retry safe and
 * turns at-least-once delivery into exactly-once semantics.
 *
 * NOTE: the exact wording and the shape of `related_document` vary across
 * Paperless-ngx versions; the contract tests in `test/` pin the versions we
 * actually support.
 */
export function interpretTask(task: PaperlessTask): ServerOutcome | 'pending' {
  // Case matters, and it varies. A real Paperless-ngx answers with lowercase
  // ("success", "failure"); the documentation and older versions use uppercase.
  // Comparing exactly against one of them meant reading every successful upload as
  // a failure -- documents sat safely in Paperless while we reported they had been
  // declined. Unit tests could not catch it, because the fixtures were written from
  // the same wrong belief as the code.
  const status = task.status.toLowerCase();
  if (status === 'pending' || status === 'started' || status === 'received') return 'pending';

  const remoteId = toRemoteId(task.related_document);
  const result = task.result ?? '';

  if (/duplicate/i.test(result)) {
    return { kind: 'duplicate', remoteId: remoteId ?? extractTrailingId(result) };
  }

  if (status === 'success') {
    // Consumed. Some versions name the document it became; some do not, in which
    // case the id has to be resolved separately rather than guessed at.
    return { kind: 'stored', remoteId };
  }

  return { kind: 'consumer_failed', message: result || `task ${task.task_id} failed` };
}

function toRemoteId(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Pulls the id out of messages like "It is a duplicate of Receipt (#4821)". */
function extractTrailingId(result: string): number | null {
  const match = /#(\d+)/.exec(result);
  return match?.[1] === undefined ? null : Number(match[1]);
}
