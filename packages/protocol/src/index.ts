/**
 * The Sheaf ingestion protocol.
 *
 * Owned by this project, on both sides, which is the entire point. Talking to a
 * server we did not design meant working around three things it could not do:
 * there was no way to ask "do you already hold these bytes", no idempotency key,
 * and duplicate detection had to be inferred from the wording of an error message
 * that varied by version.
 *
 * The fix is not a cleverer client. It is a URL.
 *
 *     PUT /v1/documents/{sha256}
 *
 * A document lives at the address of its own content, so re-sending the same bytes
 * to the same URL cannot create a second document. Idempotency is not a feature
 * here; it is a consequence of the addressing. `HEAD` on the same URL answers the
 * recovery question directly, with a status code rather than a search whose filter
 * might silently be ignored.
 *
 * Both the client and the server import this module, so a change to the wire format
 * is a compile error on both sides rather than a bug discovered in production.
 */

export const PROTOCOL_VERSION = 'v1';

export const paths = {
  health: () => `/${PROTOCOL_VERSION}/health`,
  documents: () => `/${PROTOCOL_VERSION}/documents`,
  document: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}`,
  suggestions: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/suggestions`,
  /**
   * The archive: everything the downstream system already holds, not just what
   * this server captured. A read/write proxy, not a mirror -- see
   * `ArchiveDocument` below for why nothing here is cached.
   */
  archive: () => `/${PROTOCOL_VERSION}/archive`,
  archiveVocabulary: () => `/${PROTOCOL_VERSION}/archive/vocabulary`,
  archiveDocument: (id: number | string) => `/${PROTOCOL_VERSION}/archive/${id}`,
  archiveThumbnail: (id: number | string) => `/${PROTOCOL_VERSION}/archive/${id}/thumbnail`,
} as const;

/** Documents are identified by the lowercase hex SHA-256 of their bytes. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/** The downstream system's own ids: positive integers, nothing else. */
export const PAPERLESS_ID_PATTERN = /^[1-9][0-9]*$/;

export function isPaperlessId(value: string): boolean {
  return PAPERLESS_ID_PATTERN.test(value);
}

export const AUTH_SCHEME = 'Bearer';
export const DOCUMENT_CONTENT_TYPE = 'application/pdf';

/** 25 MB. A generous multi-page scan, and a bound on what one request can cost. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * What a `PUT` meant. Both outcomes are success: the difference is only whether we
 * were the ones who stored it, which matters for reporting and for nothing else.
 */
export type PutOutcome = 'stored' | 'already-stored';

/**
 * How far a document has got on its way to a system that can actually search it.
 *
 * `pending` and `sent` are both in-flight; `done` means the downstream system has
 * it; `failed` means we stopped trying. None of these affect whether *we* hold the
 * document -- that is settled the moment it is stored.
 */
export interface ForwardStatus {
  readonly state: 'pending' | 'sent' | 'done' | 'failed';
  readonly attempts: number;
  /** How the downstream system names it, once it has one. */
  readonly remoteId: string | null;
  readonly error: string | null;
}

/**
 * What the downstream system's own classifier makes of a document, once it has had
 * a chance to look. Shaped like `@sheaf/core`'s `Suggestions` rather than importing
 * it: the wire contract evolves on its own schedule, the same reason `DocumentPatch`
 * below mirrors `MetadataPatch` instead of sharing it.
 */
export interface Suggestions {
  readonly correspondent?: string;
  readonly documentType?: string;
  readonly tags?: readonly string[];
  readonly title?: string;
  readonly date?: string;
}

export interface DocumentRecord {
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number | null;
  /** Milliseconds since epoch, assigned by the server. */
  readonly receivedAt: number;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly forward: ForwardStatus;
  /**
   * True once the server has freed the bytes for this document, which it will only
   * ever do after `forward.state` is `'done'` -- the downstream system already has
   * it. The row survives regardless: metadata and forwarding history are cheap to
   * keep, and are the only record that this document ever existed.
   */
  readonly bytesReleased: boolean;
  /**
   * `null` until the downstream system has actually answered -- which is distinct
   * from "answered and had nothing to say", `{}`. A client that treats an answer as
   * final (there is nothing left to poll for) needs that difference: asking again
   * makes sense for the first, and not for the second.
   */
  readonly suggestions: Suggestions | null;
}

export interface SuggestionsResponse {
  readonly suggestions: Suggestions | null;
}

/** Everything is optional; omitted fields are left alone, `null` clears them. */
export interface DocumentPatch {
  readonly title?: string | null;
  readonly correspondent?: string | null;
  readonly documentType?: string | null;
  readonly tags?: readonly string[];
}

/**
 * A document from the downstream system's own archive -- not necessarily
 * something this server ever stored. Fetched live and never cached here: the
 * archive is what the downstream system says it is *right now*, and this server
 * holding a second, possibly-stale copy of every document's metadata is exactly
 * the kind of duplication the rest of this protocol works to avoid.
 */
export interface ArchiveDocument {
  readonly id: number;
  readonly title: string;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly created: string;
  /** A short excerpt of the OCR text, or null when there is none yet. */
  readonly contentSnippet: string | null;
}

export interface ArchiveSearchResponse {
  readonly documents: readonly ArchiveDocument[];
  readonly count: number;
  readonly page: number;
  readonly hasMore: boolean;
}

/** An id and the name a person actually recognises it by. */
export interface VocabularyEntry {
  readonly id: number;
  readonly name: string;
}

export interface ArchiveVocabulary {
  readonly correspondents: readonly VocabularyEntry[];
  readonly documentTypes: readonly VocabularyEntry[];
  readonly tags: readonly VocabularyEntry[];
}

/** Unlike `DocumentPatch`, ids rather than free text: the archive's fields are
 * foreign keys in the downstream system, not strings this server stores itself. */
export interface ArchivePatch {
  readonly title?: string;
  readonly correspondentId?: number | null;
  readonly documentTypeId?: number | null;
  readonly tagIds?: readonly number[];
}

/**
 * Whether the downstream system actually filters
 * `original_filename__istartswith`, which crash-recovery depends on to find a
 * document it lost track of without re-uploading it. `filterSupported: false`
 * does not put a document at risk -- recovery degrades to a redundant upload the
 * server refuses as a duplicate -- but it is worth an operator knowing about
 * rather than discovering by way of unexplained re-uploads.
 */
export interface ReconciliationProbe {
  readonly filterSupported: boolean;
  /** False when there were no documents on the downstream system yet to test with. */
  readonly conclusive: boolean;
  readonly detail: string;
}

export interface HealthResponse {
  readonly name: 'sheaf-ingest';
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly documents: number;
  /**
   * Absent when no downstream system is configured. Storing is the server's job;
   * forwarding is optional, and saying so plainly beats a silent no-op.
   */
  readonly forwarding?: {
    readonly target: string;
    readonly counts: Readonly<Record<string, number>>;
    /** Absent until the one-time probe against the downstream system completes. */
    readonly reconciliation?: ReconciliationProbe;
  };
}

export interface ListResponse {
  readonly documents: readonly DocumentRecord[];
}

export interface ErrorBody {
  readonly error: ErrorCode;
  readonly detail?: string;
}

export type ErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'hash_mismatch'
  | 'malformed_id'
  | 'too_large'
  | 'bad_request'
  | 'server_error'
  | 'released'
  | 'archive_disabled';

/**
 * The status code each error maps to. Shared so the server cannot answer with one
 * code while the client is looking for another.
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  not_found: 404,
  malformed_id: 400,
  bad_request: 400,
  hash_mismatch: 409,
  too_large: 413,
  server_error: 500,
  // The document existed and is known by that address; the bytes just are not here
  // any more. That is not "not found" -- 410 says so, and distinctly enough from 404
  // that a client can tell "never happened" from "already handled".
  released: 410,
  // The route exists; browsing does not, because forwarding is not configured on
  // this server. Distinct from 404 for the same reason `released` is: a client
  // should be able to tell "no such thing" from "this feature is off".
  archive_disabled: 503,
};

export function authorization(token: string): string {
  return `${AUTH_SCHEME} ${token}`;
}

/** Parse a bearer token out of a header, without ever logging what it found. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const prefix = `${AUTH_SCHEME} `;
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}
