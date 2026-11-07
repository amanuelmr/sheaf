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
  /** Documents whose suggestions nobody has accepted or changed yet. */
  inbox: () => `/${PROTOCOL_VERSION}/inbox`,
  /** One document's details as JSON; the document's own address serves its PDF. */
  documentRecord: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/record`,
  /** Each field, with who set it and how sure a machine was. */
  documentFields: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/fields`,
  /** What happened to a document on the server, oldest first. */
  documentHistory: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/history`,
  /** `GET` a document's notes, oldest first; `POST` a `NoteBody` to add one. */
  documentNotes: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/notes`,
  /** `DELETE` one note. */
  documentNote: (sha256: string, id: number) =>
    `/${PROTOCOL_VERSION}/documents/${sha256}/notes/${String(id)}`,
  /** `GET` lists trashed documents. (`DELETE` on a document moves it here.) */
  trash: () => `/${PROTOCOL_VERSION}/trash`,
  /** `POST` a `TrashActionBody`: put documents back. */
  trashRestore: () => `/${PROTOCOL_VERSION}/trash/restore`,
  /** Admin: `POST` a `TrashActionBody` to delete for good; no `documents` empties it all. */
  trashEmpty: () => `/${PROTOCOL_VERSION}/trash/empty`,
  /** `GET` lists custom field definitions; admin `POST`s a `CustomFieldBody` to add one. */
  customFields: () => `/${PROTOCOL_VERSION}/custom-fields`,
  /** Admin: `PATCH` a `CustomFieldPatch`, or `DELETE` the field and every value of it. */
  customField: (id: number) => `/${PROTOCOL_VERSION}/custom-fields/${String(id)}`,
  /** `GET` a document's custom field values; `PUT` a `CustomFieldValuesBody` to replace them. */
  documentCustomFields: (sha256: string) =>
    `/${PROTOCOL_VERSION}/documents/${sha256}/custom-fields`,
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
  /**
   * When it was moved to the trash; present only while it is there. A trashed
   * document is left out of lists, search and forwarding, and is deleted for good
   * once the trash keeps it longer than the server's `TrashResponse.purgeAfterDays`.
   */
  readonly trashedAt?: number;
}

/** One document in the trash. */
export interface TrashEntry {
  readonly sha256: string;
  readonly title: string | null;
  /** What extraction suggested, for naming a document nobody titled. */
  readonly suggestedTitle: string | null;
  readonly receivedAt: number;
  readonly trashedAt: number;
  /** When the server will delete it for good unless it is restored first. */
  readonly purgeAt: number;
}

export interface TrashResponse {
  /** Most recently trashed first. */
  readonly documents: readonly TrashEntry[];
  readonly purgeAfterDays: number;
}

/** `POST /v1/trash/restore` and `/v1/trash/empty`. */
export interface TrashActionBody {
  /** Which documents. Required to restore; leaving it out of an empty means all of them. */
  readonly documents?: readonly string[];
}

export function isTrashActionBody(value: unknown): value is TrashActionBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const documents = (value as Record<string, unknown>)['documents'];
  return (
    documents === undefined ||
    (Array.isArray(documents) &&
      documents.length <= 1_000 &&
      documents.every((id) => typeof id === 'string' && isSha256(id)))
  );
}

/** How many documents a trash action changed. */
export interface TrashActionResponse {
  readonly count: number;
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
  /** What extraction suggested, for showing a document nobody has titled yet. */
  readonly suggestedTitle: string | null;
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

export interface InboxEntry {
  readonly sha256: string;
  readonly receivedAt: number;
  readonly title: string | null;
  readonly suggestions: Suggestions;
}

export interface InboxResponse {
  /** Newest first. */
  readonly documents: readonly InboxEntry[];
}

export interface FieldEntry {
  readonly name: string;
  readonly value: unknown;
  /** `user` once a person set or cleared it; extraction never overwrites those. */
  readonly source: 'machine' | 'user';
  readonly confidence: number;
  readonly updatedAt: number;
}

export interface FieldsResponse {
  readonly fields: readonly FieldEntry[];
}

export interface HistoryEvent {
  readonly at: number;
  readonly text: string;
}

export interface HistoryResponse {
  readonly events: readonly HistoryEvent[];
}

export interface ListResponse {
  readonly documents: readonly DocumentRecord[];
}

/**
 * The kinds of custom field. A field's type is fixed once
 * it is created: changing it would silently invalidate every value already stored.
 */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'boolean',
  'date',
  'url',
  'integer',
  'number',
  'monetary',
  'documentLink',
  'select',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const MAX_CUSTOM_FIELD_NAME = 128;
export const MAX_CUSTOM_FIELD_TEXT = 1_000;
export const MAX_SELECT_OPTIONS = 100;
export const MAX_DOCUMENT_LINKS = 100;

/** A user-defined field documents can carry. */
export interface CustomField {
  readonly id: number;
  readonly name: string;
  readonly type: CustomFieldType;
  /** The choices, for `select`; empty for every other type. */
  readonly options: readonly string[];
  /** How many documents carry it, with or without a value. */
  readonly documentCount: number;
}

export interface CustomFieldsResponse {
  /** By name. */
  readonly fields: readonly CustomField[];
}

/** `POST /v1/custom-fields`. */
export interface CustomFieldBody {
  readonly name: string;
  readonly type: CustomFieldType;
  /** Required, and non-empty, for `select`; refused for any other type. */
  readonly options?: readonly string[];
}

/** `PATCH /v1/custom-fields/{id}`. The type cannot change. Dropping an option clears it from documents. */
export interface CustomFieldPatch {
  readonly name?: string;
  readonly options?: readonly string[];
}

/**
 * Currencies whose minor unit is not hundredths, from ISO 4217. Written out rather
 * than read from `Intl`: `Intl` follows CLDR display conventions (it gives HUF and
 * IDR no decimals, IQD none instead of three), and changes with the runtime, which
 * would quietly change what an amount already stored means.
 */
const ISO_4217_MINOR_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/**
 * How many digits a currency's minor unit has, by ISO 4217: 2 for EUR, 0 for JPY,
 * 3 for KWD; 2 for any code not listed. Every place that turns an amount into minor
 * units, or back, asks this one function, so a stored amount means the same thing
 * everywhere.
 */
export function minorDigits(currency: string): number {
  return Object.hasOwn(ISO_4217_MINOR_DIGITS, currency) ? ISO_4217_MINOR_DIGITS[currency]! : 2;
}

/** An amount in minor units, the same shape extraction reads totals as. */
export interface MonetaryValue {
  readonly minor: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
}

/**
 * A value, by field type: `text`, `url`, `select` and `date` (YYYY-MM-DD) are
 * strings; `boolean` a boolean; `integer` and `number` numbers; `monetary` a
 * `MonetaryValue`; `documentLink` an array of document sha256s.
 */
export type CustomFieldData = string | number | boolean | MonetaryValue | readonly string[];

/** A field on a document. `null`: attached, with no value yet. */
export interface CustomFieldValue {
  readonly field: number;
  readonly value: CustomFieldData | null;
}

/** A field on a document, as read back. */
export interface DocumentCustomField extends CustomFieldValue {
  readonly name: string;
  readonly type: CustomFieldType;
}

export interface DocumentCustomFieldsResponse {
  /** By field name. */
  readonly values: readonly DocumentCustomField[];
}

/** `PUT /v1/documents/{sha256}/custom-fields`: the complete set the document should carry. */
export interface CustomFieldValuesBody {
  readonly values: readonly CustomFieldValue[];
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && name.length <= MAX_CUSTOM_FIELD_NAME;
}

function validOptions(options: unknown): options is readonly string[] {
  return (
    Array.isArray(options) &&
    options.length > 0 &&
    options.length <= MAX_SELECT_OPTIONS &&
    options.every(validName) &&
    new Set(options).size === options.length
  );
}

export function isCustomFieldBody(value: unknown): value is CustomFieldBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!validName(body['name'])) return false;
  if (!(CUSTOM_FIELD_TYPES as readonly unknown[]).includes(body['type'])) return false;
  return body['type'] === 'select' ? validOptions(body['options']) : body['options'] === undefined;
}

export function isCustomFieldPatch(value: unknown): value is CustomFieldPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'name' && key !== 'options')) return false;
  if (body['name'] !== undefined && !validName(body['name'])) return false;
  return body['options'] === undefined || validOptions(body['options']);
}

/**
 * Why a value does not fit a field, or null when it does. `null` always fits: it is
 * a field attached without a value. Both sides apply this one check.
 */
export function customFieldValueProblem(
  field: Pick<CustomField, 'type' | 'options'>,
  value: unknown,
): string | null {
  if (value === null) return null;
  switch (field.type) {
    case 'text':
      return typeof value === 'string' && value.length <= MAX_CUSTOM_FIELD_TEXT
        ? null
        : `text of at most ${String(MAX_CUSTOM_FIELD_TEXT)} characters`;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true or false';
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? null : 'a date as YYYY-MM-DD';
    case 'url':
      return typeof value === 'string' && isUrl(value) ? null : 'a full URL, like https://…';
    case 'integer':
      return Number.isSafeInteger(value) ? null : 'a whole number';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'a number';
    case 'monetary': {
      if (typeof value !== 'object' || Array.isArray(value)) return 'an amount and a currency';
      const { minor, currency } = value as Record<string, unknown>;
      return Number.isSafeInteger(minor) &&
        typeof currency === 'string' &&
        /^[A-Z]{3}$/.test(currency)
        ? null
        : 'an amount in minor units and a three-letter currency code';
    }
    case 'documentLink':
      return Array.isArray(value) &&
        value.length <= MAX_DOCUMENT_LINKS &&
        value.every((id) => typeof id === 'string' && isSha256(id)) &&
        new Set(value).size === value.length
        ? null
        : `up to ${String(MAX_DOCUMENT_LINKS)} distinct document ids`;
    case 'select':
      return typeof value === 'string' && field.options.includes(value)
        ? null
        : `one of: ${field.options.join(', ')}`;
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isUrl(value: string): boolean {
  if (value.length > 2_000 || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function isCustomFieldValuesBody(value: unknown): value is CustomFieldValuesBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const values = (value as Record<string, unknown>)['values'];
  if (!Array.isArray(values) || values.length > 500) return false;
  const seen = new Set<number>();
  for (const entry of values as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return false;
    const { field } = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(field) || (field as number) < 1 || seen.has(field as number)) {
      return false;
    }
    if (!('value' in entry)) return false;
    seen.add(field as number);
  }
  return true;
}

/** Longest note accepted, in characters: a paragraph or two, not a second document. */
export const MAX_NOTE_LENGTH = 5_000;

/** `POST /v1/documents/{sha256}/notes`. */
export interface NoteBody {
  readonly text: string;
}

/** The one check both sides apply: some non-blank text, within `MAX_NOTE_LENGTH`. */
export function isNoteBody(value: unknown): value is NoteBody {
  if (typeof value !== 'object' || value === null) return false;
  const text = (value as Record<string, unknown>)['text'];
  return typeof text === 'string' && text.trim() !== '' && text.length <= MAX_NOTE_LENGTH;
}

/** A person's note on a document. */
export interface Note {
  readonly id: number;
  readonly text: string;
  /** The paired phone that wrote it, by name; null for the admin token. */
  readonly author: string | null;
  readonly createdAt: number;
}

export interface NotesResponse {
  /** Oldest first. */
  readonly notes: readonly Note[];
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
  | 'rate_limited'
  | 'conflict';

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
  // The request is well formed but clashes with what exists, such as a second
  // custom field with a name already taken.
  conflict: 409,
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
