/**
 * The append-only intent log.
 *
 * Every fact about a document is an event. Nothing is ever updated or deleted.
 * All state (`DocState`) is derived by replaying events through `reduce`.
 *
 * This is what makes crash recovery structural rather than aspirational: a crash
 * can only ever truncate the log at a record boundary, so replay always yields a
 * correct state.
 */

/** SHA-256 (hex) of the normalized PDF bytes. The content hash *is* the identity. */
export type DocId = string;

export type PageId = string;

export interface PageRef {
  readonly id: PageId;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Why an upload attempt did not produce a task id. */
export type FailureReason =
  /** DNS/connect/timeout/abort — the request never got an answer. Retryable. */
  | { readonly kind: 'unreachable' }
  /** 5xx — Paperless is up but unhappy. Retryable. */
  | { readonly kind: 'server_error'; readonly status: number }
  /** 429 — back off, honouring Retry-After when present. Retryable. */
  | { readonly kind: 'rate_limited'; readonly retryAfterMs?: number }
  /** 401/403 — the token is wrong or lacks permission. Only the user can fix it. */
  | { readonly kind: 'auth'; readonly status: number }
  /** 404 — the URL does not point at a Paperless API. Only the user can fix it. */
  | { readonly kind: 'not_found' }
  /** TLS/certificate failure. Only the user can fix it. */
  | { readonly kind: 'tls'; readonly detail: string }
  /** 413 — the server will never accept this payload. */
  | { readonly kind: 'too_large' }
  /** 400 and friends: a refusal that retrying cannot change. */
  | { readonly kind: 'rejected'; readonly status: number; readonly message: string };

/**
 * What the server ultimately did with the bytes.
 *
 * `duplicate` is a SUCCESS: Paperless computes its own content hash and refuses
 * documents it already has. A duplicate rejection of bytes we intended to upload
 * is proof the document is in Paperless. This is what makes retry unconditionally
 * safe, and turns at-least-once delivery into exactly-once semantics.
 */
export type ServerOutcome =
  | { readonly kind: 'stored'; readonly remoteId: number }
  | { readonly kind: 'duplicate'; readonly remoteId: number | null }
  | { readonly kind: 'consumer_failed'; readonly message: string };

export interface Suggestions {
  readonly correspondent?: string;
  readonly documentType?: string;
  readonly tags?: readonly string[];
  readonly title?: string;
  readonly date?: string;
}

export interface MetadataPatch {
  readonly title?: string;
  readonly correspondentId?: number;
  readonly documentTypeId?: number;
  readonly tagIds?: readonly number[];
  readonly createdDate?: string;
}

/**
 * Work that happens after a document is safely on the server. Optional by nature,
 * so it must be able to fail and stop rather than retry for ever.
 */
export type SideTask = 'suggestions' | 'metadata';

interface EventBase {
  readonly docId: DocId;
  /** Milliseconds since epoch, supplied by the caller. The core never reads a clock. */
  readonly at: number;
}

export type CaptureEvent =
  /** The shutter fired and bytes are durably on disk. This is the commit point. */
  | (EventBase & {
      readonly type: 'Captured';
      readonly pages: readonly PageRef[];
      readonly sha256: string;
      readonly bytes: number;
    })
  | (EventBase & { readonly type: 'PageAdded'; readonly page: PageRef })
  | (EventBase & { readonly type: 'PageRemoved'; readonly pageId: PageId })
  /** Crop/rotate/enhance writes a new file for an existing slot. */
  | (EventBase & { readonly type: 'PageReplaced'; readonly page: PageRef })
  /** Pages are final; the assembled PDF hash is fixed. Eligible for upload. */
  | (EventBase & { readonly type: 'Enqueued'; readonly sha256: string })
  | (EventBase & { readonly type: 'UploadStarted'; readonly attempt: number })
  | (EventBase & {
      readonly type: 'UploadFailed';
      readonly attempt: number;
      readonly reason: FailureReason;
      /** Jitter in [0,1), recorded so backoff is replay-stable. */
      readonly jitter: number;
    })
  /** Paperless returned a task id. From here we poll; we NEVER re-upload. */
  | (EventBase & { readonly type: 'TaskAccepted'; readonly taskId: string })
  | (EventBase & { readonly type: 'ServerConfirmed'; readonly outcome: ServerOutcome })
  | (EventBase & { readonly type: 'SuggestionsReceived'; readonly suggestions: Suggestions })
  | (EventBase & { readonly type: 'MetadataAccepted'; readonly patch: MetadataPatch })
  | (EventBase & { readonly type: 'MetadataPatched' })
  /**
   * Post-sync enrichment failed. Carries the same shape as an upload failure so it
   * gets the same discipline: backoff, a budget, and no retrying of a refusal that
   * retrying cannot change.
   */
  | (EventBase & {
      readonly type: 'SideTaskFailed';
      readonly task: SideTask;
      readonly attempt: number;
      readonly reason: FailureReason;
      readonly jitter: number;
    })
  /** Automatic retries are exhausted. The document is still safely on this device. */
  | (EventBase & { readonly type: 'GaveUp'; readonly reason: FailureReason })
  /** The user (or regained connectivity) asked for another go. Resets the budget. */
  | (EventBase & { readonly type: 'RetryRequested' })
  /** Retention policy removed the local originals — only ever after confirmation. */
  | (EventBase & { readonly type: 'LocalFilesReleased' });

export type CaptureEventType = CaptureEvent['type'];
