import { MAX_AUTO_ATTEMPTS, backoffMs } from './backoff.ts';
import { isBlocking, isRetryable } from './errors.ts';
import type { CaptureEvent, PageRef, ServerOutcome, SideTask } from './events.ts';
import type { DocState, SideTaskState } from './state.ts';

/** Events that could move a document toward the server. Ignored once SYNCED. */
const UPLOAD_EVENTS = new Set(['UploadStarted', 'UploadFailed', 'TaskAccepted', 'GaveUp']);

function replacePage(pages: readonly PageRef[], page: PageRef): readonly PageRef[] {
  const i = pages.findIndex((p) => p.id === page.id);
  if (i === -1) return [...pages, page];
  return pages.map((p, j) => (j === i ? page : p));
}

const FRESH: SideTaskState = { attempts: 0, nextAttemptAt: null, abandoned: null };

/**
 * Post-sync work gets the same discipline as an upload: back off, spend a bounded
 * budget, and stop for a refusal that retrying cannot change.
 *
 * Without this, a server whose suggestions endpoint answers 404 gets asked again on
 * every tick, for every synced document, for ever.
 */
function applySideFailure(
  state: DocState,
  task: SideTask,
  attempt: number,
  reason: DocState['lastError'] & object,
  jitter: number,
  at: number,
): DocState {
  const giveUp = !isRetryable(reason) || attempt >= MAX_AUTO_ATTEMPTS;
  const next: SideTaskState = {
    attempts: attempt,
    nextAttemptAt: giveUp ? null : at + backoffMs(attempt, jitter),
    abandoned: giveUp ? reason : null,
  };
  return { ...state, side: { ...state.side, [task]: next }, updatedAt: at };
}

function applyServerConfirmed(state: DocState, outcome: ServerOutcome, at: number): DocState {
  switch (outcome.kind) {
    case 'stored':
      return {
        ...state,
        status: 'SYNCED',
        remoteId: outcome.remoteId,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: at,
      };
    case 'duplicate':
      // Paperless refusing our bytes as a duplicate is PROOF it has them.
      // This is what makes retry unconditionally safe.
      return {
        ...state,
        status: 'SYNCED',
        remoteId: outcome.remoteId,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: at,
      };
    case 'consumer_failed':
      return {
        ...state,
        status: 'FAILED',
        lastError: { kind: 'rejected', status: 0, message: outcome.message },
        nextAttemptAt: null,
        updatedAt: at,
      };
  }
}

/**
 * Apply one event. Pure, total, and idempotent for events that cannot legally
 * apply to the current state (they are ignored rather than throwing, so a
 * replayed or duplicated log never crashes the app).
 */
export function apply(state: DocState, event: CaptureEvent): DocState {
  // A confirmed document is done. Nothing about uploading can change that.
  if (state.status === 'SYNCED' && UPLOAD_EVENTS.has(event.type)) return state;

  const at = event.at;

  switch (event.type) {
    case 'Captured':
      return state;

    case 'PageAdded':
      // Pages freeze when the hash is fixed at Enqueued.
      if (state.status !== 'DRAFT') return state;
      return { ...state, pages: [...state.pages, event.page], updatedAt: at };

    case 'PageReplaced':
      if (state.status !== 'DRAFT') return state;
      return { ...state, pages: replacePage(state.pages, event.page), updatedAt: at };

    case 'PageRemoved':
      if (state.status !== 'DRAFT') return state;
      return {
        ...state,
        pages: state.pages.filter((p) => p.id !== event.pageId),
        updatedAt: at,
      };

    case 'Enqueued':
      if (state.status !== 'DRAFT') return state;
      return { ...state, status: 'QUEUED', sha256: event.sha256, updatedAt: at };

    case 'UploadStarted':
      return { ...state, status: 'UPLOADING', attempts: event.attempt, updatedAt: at };

    case 'UploadFailed': {
      const { reason, attempt, jitter } = event;
      const base = {
        ...state,
        attempts: attempt,
        lastError: reason,
        lastFailureAt: at,
        updatedAt: at,
      };
      if (isBlocking(reason)) {
        return { ...base, status: 'BLOCKED' as const, nextAttemptAt: null };
      }
      if (!isRetryable(reason) || attempt >= MAX_AUTO_ATTEMPTS) {
        return { ...base, status: 'FAILED' as const, nextAttemptAt: null };
      }
      const delay =
        reason.kind === 'rate_limited' && reason.retryAfterMs !== undefined
          ? reason.retryAfterMs
          : backoffMs(attempt, jitter);
      return { ...base, status: 'BACKOFF' as const, nextAttemptAt: at + delay };
    }

    case 'TaskAccepted':
      // From here the bytes may be on the server. Poll; never re-upload.
      return {
        ...state,
        status: 'AWAITING_SERVER',
        taskId: event.taskId,
        nextAttemptAt: null,
        updatedAt: at,
      };

    case 'ServerConfirmed':
      return applyServerConfirmed(state, event.outcome, at);

    case 'GaveUp':
      return {
        ...state,
        status: 'FAILED',
        lastError: event.reason,
        nextAttemptAt: null,
        updatedAt: at,
      };

    case 'RetryRequested':
      // A synced document has nothing to re-upload, but its abandoned post-sync
      // work can be given another go.
      if (state.status === 'SYNCED') {
        return { ...state, side: { suggestions: FRESH, metadata: FRESH }, updatedAt: at };
      }
      // Never re-arm a document the server might already hold.
      if (state.status !== 'FAILED' && state.status !== 'BLOCKED' && state.status !== 'BACKOFF') {
        return state;
      }
      return {
        ...state,
        status: 'QUEUED',
        attempts: 0,
        nextAttemptAt: null,
        side: { suggestions: FRESH, metadata: FRESH },
        updatedAt: at,
      };

    case 'SuggestionsReceived':
      return {
        ...state,
        suggestions: event.suggestions,
        side: { ...state.side, suggestions: FRESH },
        updatedAt: at,
      };

    case 'MetadataAccepted':
      // Fresh intent deserves a fresh budget, even if a previous patch was abandoned.
      return {
        ...state,
        metadata: { ...state.metadata, ...event.patch },
        metadataPatched: false,
        side: { ...state.side, metadata: FRESH },
        updatedAt: at,
      };

    case 'MetadataPatched':
      return {
        ...state,
        metadataPatched: true,
        side: { ...state.side, metadata: FRESH },
        updatedAt: at,
      };

    case 'SideTaskFailed':
      return applySideFailure(state, event.task, event.attempt, event.reason, event.jitter, at);

    case 'LocalFilesReleased':
      // Only ever emitted after confirmation; the reducer does not police policy,
      // but it does refuse to record a release for an unconfirmed document.
      if (state.status !== 'SYNCED') return state;
      return { ...state, localFilesPresent: false, updatedAt: at };
  }
}

/**
 * Replay a document's log into its current state.
 *
 * A crash can only truncate the log at a record boundary, so replaying any prefix
 * yields a valid state. That is the whole of the crash-recovery story.
 */
export function reduce(events: readonly CaptureEvent[]): DocState {
  const first = events[0];
  if (!first || first.type !== 'Captured') {
    throw new Error('capture log must begin with a Captured event');
  }
  let state: DocState = {
    docId: first.docId,
    sha256: first.sha256,
    bytes: first.bytes,
    pages: first.pages,
    status: 'DRAFT',
    attempts: 0,
    taskId: null,
    remoteId: null,
    lastError: null,
    lastFailureAt: null,
    nextAttemptAt: null,
    suggestions: null,
    metadata: null,
    metadataPatched: false,
    thumbnailPath: first.thumbnailPath ?? null,
    localFilesPresent: true,
    side: { suggestions: FRESH, metadata: FRESH },
    createdAt: first.at,
    updatedAt: first.at,
  };
  for (const event of events) state = apply(state, event);
  return state;
}
