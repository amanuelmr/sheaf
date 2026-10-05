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
  /** Admin: `POST` creates a one-time pairing code (ADR 0008). */
  pairingCodes: () => `/${PROTOCOL_VERSION}/pairing-codes`,
  /** `POST` a code to become a paired device. The only route that needs no token. */
  pair: () => `/${PROTOCOL_VERSION}/pair`,
  /** Admin: `GET` lists paired devices. */
  devices: () => `/${PROTOCOL_VERSION}/devices`,
  /** Admin: `DELETE` revokes one. */
  device: (id: string) => `/${PROTOCOL_VERSION}/devices/${id}`,
  /** `GET ?q=&limit=&offset=`: full-text search of the server's own catalog. */
  search: () => `/${PROTOCOL_VERSION}/search`,
  document: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}`,
  suggestions: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/suggestions`,
  /** Text a client already recognised in a stored document. See `DocumentTextBody`. */
  documentText: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/text`,
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
 * 1 MB of text: hundreds of dense pages. More than that is not recognised text from
 * a phone scan, and refusing it keeps one request from costing the server much.
 */
export const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * `PUT /v1/documents/{sha256}/text` (ADR 0009).
 *
 * The phone has already read every page with the platform's own OCR by the time a
 * document is stored, so it sends that text rather than making the server read the
 * pages again. Idempotent by document and `source`: sending the same text twice
 * changes nothing, and newer text for the same source replaces older.
 *
 * Answers 204 when stored, 404 for a document the server does not hold, 413 over
 * `MAX_TEXT_BYTES`, and 400 for anything that is not this shape.
 */
export interface DocumentTextBody {
  /** Where the text came from. Only the phone sends it today. */
  readonly source: 'edge';
  /** Which recogniser produced it, for comparing quality later: e.g. `apple-vision`, `mlkit`. */
  readonly engine: string;
  readonly text: string;
}

/** The one check both sides apply, so the client cannot send what the server refuses. */
export function isDocumentTextBody(value: unknown): value is DocumentTextBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    body['source'] === 'edge' &&
    typeof body['engine'] === 'string' &&
    /^[a-z0-9][a-z0-9.-]{0,39}$/.test(body['engine']) &&
    typeof body['text'] === 'string'
  );
}

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
    /** Absent when retention is off -- see SHEAF_RETENTION_DAYS. */
    readonly retention?: {
      readonly days: number;
      /** How many documents have actually had their bytes freed so far. */
      readonly released: number;
    };
  };
}

/** One document matching a search of the server's own catalog. */
export interface SearchHit {
  readonly sha256: string;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly receivedAt: number;
  /**
   * A short excerpt around the match, with each matched word wrapped in « and ».
   * Document text: escape it before putting it in HTML.
   */
  readonly snippet: string;
}

/** Bounds on `limit` for `GET /v1/search`. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

export interface SearchResponse {
  /** Best match first. */
  readonly hits: readonly SearchHit[];
  readonly hasMore: boolean;
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
  | 'archive_disabled'
  | 'device_revoked'
  | 'pairing_invalid'
  | 'forbidden'
  | 'rate_limited';

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
  // Told apart from `unauthenticated` so the phone can say "this phone was removed"
  // rather than "check your token", which would send someone hunting for a typo.
  device_revoked: 401,
  // Unknown, used and expired codes look the same, so nothing is learned by guessing.
  pairing_invalid: 400,
  // A device token asking for an admin-only route.
  forbidden: 403,
  rate_limited: 429,
};

export interface PairingCodeResponse {
  /** Base32 in groups of four, e.g. `K7QX-…`; case and dashes do not matter. */
  readonly code: string;
  readonly expiresAt: number;
}

export interface PairRequest {
  readonly code: string;
  readonly deviceName: string;
}

export interface PairResponse {
  readonly deviceId: string;
  /** Shown once. The server keeps only its hash. */
  readonly token: string;
}

export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number | null;
  readonly revoked: boolean;
}

export interface DevicesResponse {
  readonly devices: readonly DeviceSummary[];
}

/**
 * The link a pairing QR code holds. Scanning it with the phone's own camera opens
 * Sheaf (the `sheaf` scheme), already knowing where to connect and with what code.
 */
export function pairingUri(server: string, code: string): string {
  return `sheaf://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

/** The server and code in a pairing link, or null for anything else. */
export function parsePairingUri(uri: string): { server: string; code: string } | null {
  const match = /^sheaf:\/\/pair\?(.*)$/i.exec(uri.trim());
  if (match === null) return null;
  const params = new URLSearchParams(match[1]);
  const server = params.get('server');
  const code = params.get('code');
  if (server === null || code === null || code.trim() === '') return null;
  if (!/^https?:\/\/[^\s/]+/i.test(server)) return null;
  return { server: server.replace(/\/+$/, ''), code: code.trim() };
}

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
