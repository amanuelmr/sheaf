import type {
  DocId,
  FailureReason,
  MetadataPatch,
  PageRef,
  RemoteId,
  SideTask,
  Suggestions,
} from './events.ts';

/**
 * Status is DERIVED, never stored. That is what makes an invalid state transition
 * unrepresentable rather than merely discouraged.
 */
export type DocStatus =
  /** Captured, pages still open for editing. Not yet eligible for upload. */
  | 'DRAFT'
  /** Pages frozen, hash fixed, waiting for a chance to upload. */
  | 'QUEUED'
  /** A request is in flight. */
  | 'UPLOADING'
  /**
   * Paperless returned a task id. The bytes may already be stored, so we poll for
   * the outcome and NEVER re-upload from this state. This is the state that stops
   * "response lost in a tunnel" from becoming a duplicate.
   */
  | 'AWAITING_SERVER'
  /** A retryable failure; waiting out the backoff. */
  | 'BACKOFF'
  /** The server confirmed it has the document (stored, or already had it). */
  | 'SYNCED'
  /** Auth/URL/TLS problem. Backoff cannot help; the user must change a setting. */
  | 'BLOCKED'
  /** Automatic retries are done. The document is still safely on this device. */
  | 'FAILED';

/** Retry budget for one piece of post-sync work. */
export interface SideTaskState {
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  /** Set once we have stopped trying. The document is already safe either way. */
  readonly abandoned: FailureReason | null;
}

export interface DocState {
  readonly docId: DocId;
  readonly sha256: string;
  readonly bytes: number;
  readonly pages: readonly PageRef[];
  readonly status: DocStatus;
  /** Number of upload attempts made in the current budget. */
  readonly attempts: number;
  readonly taskId: string | null;
  readonly remoteId: RemoteId | null;
  readonly lastError: FailureReason | null;
  readonly lastFailureAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly suggestions: Suggestions | null;
  readonly metadata: MetadataPatch | null;
  readonly metadataPatched: boolean;
  readonly localFilesPresent: boolean;
  readonly side: Readonly<Record<SideTask, SideTaskState>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A document the user can no longer influence by waiting. */
export function needsUser(state: DocState): boolean {
  return state.status === 'BLOCKED' || state.status === 'FAILED';
}

/**
 * The document is on the server, but something the user asked for did not stick.
 * Worth surfacing: it is the only case where SYNCED still needs attention.
 */
export function hasUnsavedDetails(state: DocState): boolean {
  return (
    state.status === 'SYNCED' &&
    state.metadata !== null &&
    !state.metadataPatched &&
    state.side.metadata.abandoned !== null
  );
}

/** The server has it. Safe to consider the local copy redundant. */
export function isSynced(state: DocState): boolean {
  return state.status === 'SYNCED';
}

/**
 * True while Paperless might already hold these bytes. Uploading again from here
 * is the one operation that can create a duplicate, so it is forbidden.
 */
export function mayBeOnServer(state: DocState): boolean {
  return state.status === 'UPLOADING' || state.status === 'AWAITING_SERVER' || isSynced(state);
}
