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
  /** `GET` lists one kind of label with counts; admin `POST`s a `LabelBody` to add one. */
  labels: (kind: LabelKind) => `/${PROTOCOL_VERSION}/labels/${LABEL_SEGMENTS[kind]}`,
  /** Admin: `PATCH` a `LabelPatch`, or `DELETE` it from every document. */
  label: (kind: LabelKind, id: number) =>
    `/${PROTOCOL_VERSION}/labels/${LABEL_SEGMENTS[kind]}/${String(id)}`,
  /** Admin: `POST` a `LabelMergeBody` to fold this label into another. */
  labelMerge: (kind: LabelKind, id: number) =>
    `/${PROTOCOL_VERSION}/labels/${LABEL_SEGMENTS[kind]}/${String(id)}/merge`,
  /** Admin: `POST` an `ApplyRulesBody` to run every label's matching rule again. */
  labelsApply: () => `/${PROTOCOL_VERSION}/labels/apply`,
  /** `GET` a document's share links; admin `POST`s a `ShareLinkBody` to make one. */
  documentShareLinks: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/share-links`,
  /** Admin: `DELETE` stops a share link working. */
  shareLink: (id: number) => `/${PROTOCOL_VERSION}/share-links/${String(id)}`,
  /**
   * The document behind a share link, for anyone holding it: no token. Outside the
   * versioned protocol, because it is a link people open, not an API call.
   */
  shared: (slug: string) => `/share/${slug}`,
  /** `POST` a `SessionBody` to sign in as a user: needs no token. */
  sessions: () => `/${PROTOCOL_VERSION}/sessions`,
  /** `DELETE` signs this session out. */
  currentSession: () => `/${PROTOCOL_VERSION}/sessions/current`,
  /** `GET` whether single sign-on is on, needing no token. */
  sso: () => `/${PROTOCOL_VERSION}/sso`,
  /** Opened in the browser: goes to the identity provider to sign in. */
  ssoStart: () => `/${PROTOCOL_VERSION}/sso/start`,
  /** Where the provider sends the person back. */
  ssoCallback: () => `/${PROTOCOL_VERSION}/sso/callback`,
  /** `GET` who this token belongs to and what it may do. */
  me: () => `/${PROTOCOL_VERSION}/me`,
  /** `GET` every user's id and name, for choosing whom to share a document with. */
  userDirectory: () => `/${PROTOCOL_VERSION}/users/directory`,
  /** `GET` who may see and change a document; its owner or an admin `PUT`s `DocumentPermissions`. */
  documentPermissions: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/permissions`,
  /** Admin: `GET` lists users, `POST` a `UserBody` adds one. */
  users: () => `/${PROTOCOL_VERSION}/users`,
  /** Admin: `PATCH` a `UserPatch`, or `DELETE` the user and their sessions. */
  user: (id: number) => `/${PROTOCOL_VERSION}/users/${String(id)}`,
  /** Admin: `GET ?limit=&before=` the newest changes made through the API. */
  audit: () => `/${PROTOCOL_VERSION}/audit`,
  /** Admin: `GET` the server's settings; `PATCH` a `SettingsPatch` to change some. */
  settings: () => `/${PROTOCOL_VERSION}/settings`,
  /** `GET` lists workflows; admin `POST`s a `WorkflowBody` to add one. */
  workflows: () => `/${PROTOCOL_VERSION}/workflows`,
  /** Admin: `PUT` a `WorkflowBody` to replace one, or `DELETE` it. */
  workflow: (id: number) => `/${PROTOCOL_VERSION}/workflows/${String(id)}`,
  /** `GET` the lowest archive serial number above every one in use. */
  nextAsn: () => `/${PROTOCOL_VERSION}/documents/next-asn`,
  /** `GET` how many pages; `POST` a `PagesBody` to turn, drop or reorder them. */
  documentPages: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/pages`,
  /**
   * `GET` the PDF with its recognised text laid invisibly inside, so other apps find
   * it by its words. Made on request; the stored file is unchanged.
   */
  documentSearchable: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/searchable.pdf`,
  /** `POST` a `StampBody`: words in a box on the page, kept as a new version. */
  documentStamp: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/stamp`,
  /** `POST` a `SplitBody`: one new document per part. */
  documentSplit: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/split`,
  /** `POST` a `MergeBody`: one new document of all their pages. */
  mergeDocuments: () => `/${PROTOCOL_VERSION}/documents/merge`,
  /** `GET` how often each field's suggestion was right, on the latest documents people filed. */
  accuracy: () => `/${PROTOCOL_VERSION}/accuracy`,
  /** `GET` documents whose text says much the same: re-scans of the same paper. */
  documentSimilar: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/similar`,
  /** `GET` a document's earlier files. */
  documentVersions: (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/versions`,
  /** `GET` one earlier file as a PDF. */
  documentVersion: (sha256: string, version: string) =>
    `/${PROTOCOL_VERSION}/documents/${sha256}/versions/${version}`,
  /** `POST`: make that earlier file the document's again. */
  restoreVersion: (sha256: string, version: string) =>
    `/${PROTOCOL_VERSION}/documents/${sha256}/versions/${version}/restore`,
  /** `POST` a `BulkEditBody`: one change to many documents. */
  bulkEdit: () => `/${PROTOCOL_VERSION}/documents/bulk`,
  /** `GET` lists saved views; `POST` a `SavedViewBody` to save one. */
  views: () => `/${PROTOCOL_VERSION}/views`,
  /** `PATCH` a `SavedViewPatch`, or `DELETE` it. */
  view: (id: number) => `/${PROTOCOL_VERSION}/views/${String(id)}`,
  /**
   * `GET ?q=&limit=&offset=` plus a `DocumentFilter` (see `filterToParams`):
   * full-text search of the server's own catalog, or with no `q`, every document
   * the filter lets through.
   */
  search: () => `/${PROTOCOL_VERSION}/search`,
  /**
   * `GET` with the same filter as `search`: every matching document as a CSV file,
   * a column per custom field. `x-sheaf-truncated: true` when there were more.
   */
  searchExport: () => `/${PROTOCOL_VERSION}/search/export.csv`,
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
  /** The date on the document itself, YYYY-MM-DD, as a person set it; null until then. */
  readonly created: string | null;
  /** Archive serial number: ties the document to its paper original. Unique. */
  readonly asn: number | null;
  /**
   * The user it belongs to, or null when it is shared with everyone. A document a
   * person uploads is theirs; one from a phone or the admin token is shared.
   */
  readonly owner: number | null;
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

/** How often one field's suggestions were kept as they were. */
export interface FieldAccuracy {
  readonly field: 'title' | 'date' | 'correspondent' | 'documentType' | 'tags';
  /** Suggestions a person kept unchanged. */
  readonly right: number;
  /** Suggestions a person kept or changed, newest first, at most `window`. */
  readonly judged: number;
}

export interface AccuracyResponse {
  readonly window: number;
  readonly fields: readonly FieldAccuracy[];
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
  /** YYYY-MM-DD. */
  readonly created?: string | null;
  /** 1 to `MAX_ASN`; another document's number is refused with 409. */
  readonly asn?: number | null;
}

export const MAX_ASN = 2_147_483_647;

export interface NextAsnResponse {
  readonly asn: number;
}

/**
 * The shape `PATCH /v1/documents/{sha256}` accepts. Keys it does not know are
 * left alone rather than refused, so an older or newer client still works.
 */
export function documentPatchProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'body must be a JSON object';
  }
  const patch = value as Record<string, unknown>;
  for (const key of ['title', 'correspondent', 'documentType']) {
    const v = patch[key];
    if (v !== undefined && v !== null && typeof v !== 'string')
      return `${key} must be text or null`;
  }
  const tags = patch['tags'];
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string'))) {
    return 'tags must be a list of names';
  }
  const created = patch['created'];
  if (
    created !== undefined &&
    created !== null &&
    (typeof created !== 'string' || !isDay(created))
  ) {
    return 'created must be a day, YYYY-MM-DD, or null';
  }
  const asn = patch['asn'];
  if (
    asn !== undefined &&
    asn !== null &&
    !(Number.isSafeInteger(asn) && (asn as number) >= 1 && (asn as number) <= MAX_ASN)
  ) {
    return `asn must be a whole number from 1 to ${String(MAX_ASN)}, or null`;
  }
  return null;
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
  readonly created: string | null;
  readonly asn: number | null;
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
  /** In the order asked for; best match first by default when searching for words. */
  readonly hits: readonly SearchHit[];
  readonly hasMore: boolean;
  /** How many documents match in all, across every page. */
  readonly total: number;
}

export const SEARCH_SORTS = ['relevance', 'newest', 'oldest', 'title', 'created', 'asn'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/**
 * Which documents to show. Every part is optional and they all apply together.
 * Within a list, `correspondents` and `documentTypes` mean any one of them, tags in
 * `tags` must all be there, one of `anyTags` must be, and none of `notTags` may be.
 */
export interface DocumentFilter {
  /** Words to search for, as typed. */
  readonly text?: string;
  readonly correspondents?: readonly string[];
  readonly documentTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly anyTags?: readonly string[];
  readonly notTags?: readonly string[];
  /** Received on or after this day, YYYY-MM-DD, in UTC. */
  readonly receivedFrom?: string;
  /** Received on or before this day, YYYY-MM-DD, in UTC. */
  readonly receivedTo?: string;
  /** Dated on or after this day, by the date on the document. */
  readonly createdFrom?: string;
  /** Dated on or before this day. */
  readonly createdTo?: string;
  /** This archive serial number. */
  readonly asn?: number;
  /** Carries each of these custom fields, by id. */
  readonly fields?: readonly number[];
  /** Relevance needs words; without any, it falls back to newest. */
  readonly sort?: SearchSort;
}

const FILTER_LISTS = {
  correspondents: 'correspondent',
  documentTypes: 'type',
  tags: 'tag',
  anyTags: 'anyTag',
  notTags: 'notTag',
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD: not 2026-02-30. */
function isDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/** A filter as query parameters, the way `GET /v1/search` reads it. */
export function filterToParams(filter: DocumentFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.text !== undefined && filter.text.trim() !== '') params.set('q', filter.text);
  for (const [key, param] of Object.entries(FILTER_LISTS)) {
    for (const value of filter[key as keyof typeof FILTER_LISTS] ?? []) params.append(param, value);
  }
  if (filter.receivedFrom !== undefined) params.set('from', filter.receivedFrom);
  if (filter.receivedTo !== undefined) params.set('to', filter.receivedTo);
  if (filter.createdFrom !== undefined) params.set('createdFrom', filter.createdFrom);
  if (filter.createdTo !== undefined) params.set('createdTo', filter.createdTo);
  if (filter.asn !== undefined) params.set('asn', String(filter.asn));
  for (const id of filter.fields ?? []) params.append('field', String(id));
  if (filter.sort !== undefined) params.set('sort', filter.sort);
  return params;
}

/** Reads `filterToParams` back, or says what is wrong with the parameters. */
export function filterFromParams(
  params: URLSearchParams,
): { ok: true; filter: DocumentFilter } | { ok: false; problem: string } {
  const filter: { -readonly [K in keyof DocumentFilter]: DocumentFilter[K] } = {};
  const q = params.get('q');
  if (q !== null && q.trim() !== '') filter.text = q;
  for (const [key, param] of Object.entries(FILTER_LISTS)) {
    const values = params.getAll(param);
    if (values.length > MAX_FILTER_VALUES) return { ok: false, problem: `too many ${param}s` };
    if (values.some((v) => v === '' || v.length > MAX_LABEL_NAME)) {
      return { ok: false, problem: `each ${param} must be a name` };
    }
    if (values.length > 0) filter[key as keyof typeof FILTER_LISTS] = values;
  }
  for (const [param, key] of [
    ['from', 'receivedFrom'],
    ['to', 'receivedTo'],
    ['createdFrom', 'createdFrom'],
    ['createdTo', 'createdTo'],
  ] as const) {
    const day = params.get(param);
    if (day === null) continue;
    if (!isDay(day)) {
      return { ok: false, problem: `${param} must be a day, YYYY-MM-DD` };
    }
    filter[key] = day;
  }
  const asn = params.get('asn');
  if (asn !== null) {
    if (!/^[1-9][0-9]{0,9}$/.test(asn) || Number(asn) > MAX_ASN) {
      return { ok: false, problem: 'asn must be an archive serial number' };
    }
    filter.asn = Number(asn);
  }
  const fields = params.getAll('field');
  if (fields.length > MAX_FILTER_VALUES || fields.some((f) => !/^[1-9][0-9]{0,15}$/.test(f))) {
    return { ok: false, problem: 'each field must be a custom field id' };
  }
  if (fields.length > 0) filter.fields = fields.map(Number);
  const sort = params.get('sort');
  if (sort !== null) {
    if (!(SEARCH_SORTS as readonly string[]).includes(sort)) {
      return { ok: false, problem: `sort must be one of ${SEARCH_SORTS.join(', ')}` };
    }
    filter.sort = sort as SearchSort;
  }
  return { ok: true, filter };
}

export const MAX_FILTER_VALUES = 50;

export function isDocumentFilter(value: unknown): value is DocumentFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  const known = [
    'text',
    ...Object.keys(FILTER_LISTS),
    'receivedFrom',
    'receivedTo',
    'createdFrom',
    'createdTo',
    'asn',
    'fields',
    'sort',
  ];
  if (Object.keys(filter).some((key) => !known.includes(key))) return false;
  if (filter['text'] !== undefined && typeof filter['text'] !== 'string') return false;
  for (const key of Object.keys(FILTER_LISTS)) {
    const list = filter[key];
    if (list !== undefined && (!Array.isArray(list) || !list.every((v) => typeof v === 'string'))) {
      return false;
    }
  }
  const fields = filter['fields'];
  if (
    fields !== undefined &&
    (!Array.isArray(fields) || !fields.every((f) => Number.isSafeInteger(f) && (f as number) > 0))
  ) {
    return false;
  }
  for (const key of ['receivedFrom', 'receivedTo', 'createdFrom', 'createdTo']) {
    if (filter[key] !== undefined && typeof filter[key] !== 'string') return false;
  }
  if (filter['asn'] !== undefined && typeof filter['asn'] !== 'number') return false;
  if (filter['sort'] !== undefined && typeof filter['sort'] !== 'string') return false;
  // Everything else is the same check the query parameters get.
  return filterFromParams(filterToParams(value)).ok;
}

/** A filter kept under a name, to come back to. */
export interface SavedView {
  readonly id: number;
  readonly name: string;
  readonly filter: DocumentFilter;
  /** Shown on the home page with its count. */
  readonly onDashboard: boolean;
  /** Smaller first, among views on the dashboard. */
  readonly position: number;
}

export interface SavedViewsResponse {
  /** Dashboard order first, then by name. */
  readonly views: readonly SavedView[];
}

export interface SavedViewBody {
  readonly name: string;
  readonly filter: DocumentFilter;
  readonly onDashboard?: boolean;
}

export interface SavedViewPatch {
  readonly name?: string;
  readonly filter?: DocumentFilter;
  readonly onDashboard?: boolean;
  readonly position?: number;
}

export function isSavedViewBody(value: unknown): value is SavedViewBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['name', 'filter', 'onDashboard'].includes(key)))
    return false;
  return (
    validLabelName(body['name']) &&
    isDocumentFilter(body['filter']) &&
    (body['onDashboard'] === undefined || typeof body['onDashboard'] === 'boolean')
  );
}

export function isSavedViewPatch(value: unknown): value is SavedViewPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = ['name', 'filter', 'onDashboard', 'position'];
  if (Object.keys(body).some((key) => !keys.includes(key))) return false;
  return (
    (body['name'] === undefined || validLabelName(body['name'])) &&
    (body['filter'] === undefined || isDocumentFilter(body['filter'])) &&
    (body['onDashboard'] === undefined || typeof body['onDashboard'] === 'boolean') &&
    (body['position'] === undefined ||
      (Number.isSafeInteger(body['position']) && Math.abs(body['position'] as number) < 1e9))
  );
}

export interface InboxEntry {
  readonly sha256: string;
  readonly receivedAt: number;
  readonly title: string | null;
  readonly suggestions: Suggestions;
  /** An earlier document whose text says much the same: likely the same paper scanned again. */
  readonly looksLike?: SimilarDocument;
}

/** A document whose words mostly match another's. */
export interface SimilarDocument {
  readonly sha256: string;
  readonly title: string | null;
  readonly receivedAt: number;
  /** The share of word pairs the two are estimated to have in common, 0 to 1. */
  readonly similarity: number;
}

export interface SimilarResponse {
  /** Most alike first; only those alike enough to be the same paper. */
  readonly documents: readonly SimilarDocument[];
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
  /**
   * Every document should have a value. A person saving a document's fields without
   * one is refused; documents filed by rules or workflows are flagged, not refused.
   */
  readonly required: boolean;
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
  /** Default false. See `CustomField.required`. */
  readonly required?: boolean;
}

/** `PATCH /v1/custom-fields/{id}`. The type cannot change. Dropping an option clears it from documents. */
export interface CustomFieldPatch {
  readonly name?: string;
  readonly options?: readonly string[];
  readonly required?: boolean;
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
  if (body['required'] !== undefined && typeof body['required'] !== 'boolean') return false;
  return body['type'] === 'select' ? validOptions(body['options']) : body['options'] === undefined;
}

export function isCustomFieldPatch(value: unknown): value is CustomFieldPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'name' && key !== 'options' && key !== 'required'))
    return false;
  if (body['name'] !== undefined && !validName(body['name'])) return false;
  if (body['required'] !== undefined && typeof body['required'] !== 'boolean') return false;
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

/**
 * The three kinds of name a document is filed under. A document has at most one
 * correspondent and one document type, and any number of tags.
 */
export const LABEL_KINDS = ['correspondent', 'documentType', 'tag'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

/** How each kind is spelled in a path. */
export const LABEL_SEGMENTS: Readonly<Record<LabelKind, string>> = {
  correspondent: 'correspondents',
  documentType: 'document-types',
  tag: 'tags',
};

export const MAX_LABEL_NAME = 128;

/** `#rrggbb`, lower or upper case. */
export const LABEL_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * How a label finds its own documents in their text:
 * - `none`: never on its own;
 * - `any`: any one of the words, where a "quoted phrase" counts as one word;
 * - `all`: every one of the words, in any order;
 * - `exact`: the pattern as written, anywhere;
 * - `regex`: a JavaScript regular expression;
 * - `fuzzy`: the pattern, allowing for a few misread letters.
 */
export const MATCHING_ALGORITHMS = ['none', 'any', 'all', 'exact', 'regex', 'fuzzy'] as const;
export type MatchingAlgorithm = (typeof MATCHING_ALGORITHMS)[number];

export const MAX_MATCH_PATTERN = 512;

/** Fuzzy matching costs time in proportion to the pattern's length, so it is kept short. */
export const MAX_FUZZY_PATTERN = 64;

export interface MatchingRule {
  readonly algorithm: MatchingAlgorithm;
  /** Empty for `none`. */
  readonly pattern: string;
  readonly caseSensitive: boolean;
}

export const NO_MATCHING: MatchingRule = { algorithm: 'none', pattern: '', caseSensitive: false };

/** One correspondent, document type or tag, and how many documents carry it. */
export interface Label {
  readonly id: number;
  readonly kind: LabelKind;
  readonly name: string;
  /** Documents filed under it, leaving out those in the trash. */
  readonly documents: number;
  /** Tags only; null when none was chosen. */
  readonly colour: string | null;
  readonly matching: MatchingRule;
  /** Tags only: put on every new document, to mark it as not yet looked at. */
  readonly inbox: boolean;
  /** Tags only: the tag this one sits inside, whose name every document with this one also has. */
  readonly parent: number | null;
}

/** How deep tags may nest: a tag, its parent, and so on, five in all. */
export const MAX_TAG_DEPTH = 5;

export interface LabelsResponse {
  /** By name. */
  readonly labels: readonly Label[];
}

/** `POST /v1/labels/{kind}`. A colour is for tags only. */
export interface LabelBody {
  readonly name: string;
  readonly colour?: string;
  readonly matching?: MatchingRule;
  /** Tags only. */
  readonly inbox?: boolean;
  /** Tags only: a parent tag's id. */
  readonly parent?: number | null;
}

/**
 * `PATCH /v1/labels/{kind}/{id}`. A new name is applied to every document that
 * carries the label; `colour: null` clears it.
 */
export interface LabelPatch {
  readonly name?: string;
  readonly colour?: string | null;
  readonly matching?: MatchingRule;
  readonly inbox?: boolean;
  /** Tags only: a parent tag's id, or null for none. */
  readonly parent?: number | null;
}

/** `POST /v1/labels/apply`. Leaving out `documents` means every document. */
export interface ApplyRulesBody {
  readonly documents?: readonly string[];
}

export interface ApplyRulesResponse {
  /** Documents that gained a label. */
  readonly changed: number;
}

/**
 * Why a rule cannot be used, or null when it can. `none` takes no pattern; the
 * others need one, and a regex must compile.
 */
export function matchingRuleProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'matching must be {"algorithm", "pattern", "caseSensitive"}';
  }
  const rule = value as Record<string, unknown>;
  if (Object.keys(rule).some((k) => !['algorithm', 'pattern', 'caseSensitive'].includes(k))) {
    return 'matching may hold only "algorithm", "pattern" and "caseSensitive"';
  }
  if (!(MATCHING_ALGORITHMS as readonly unknown[]).includes(rule['algorithm'])) {
    return `algorithm must be one of ${MATCHING_ALGORITHMS.join(', ')}`;
  }
  const pattern = rule['pattern'];
  if (typeof pattern !== 'string' || pattern.length > MAX_MATCH_PATTERN) {
    return `pattern must be text of at most ${String(MAX_MATCH_PATTERN)} characters`;
  }
  if (typeof rule['caseSensitive'] !== 'boolean') return 'caseSensitive must be true or false';
  if (rule['algorithm'] === 'none') return pattern === '' ? null : 'none takes no pattern';
  if (pattern.trim() === '') return 'this algorithm needs a pattern';
  if (rule['algorithm'] === 'fuzzy' && pattern.length > MAX_FUZZY_PATTERN) {
    return `a fuzzy pattern is at most ${String(MAX_FUZZY_PATTERN)} characters`;
  }
  if (rule['algorithm'] === 'regex') {
    try {
      new RegExp(pattern, 'u');
    } catch {
      return 'pattern is not a valid regular expression';
    }
  }
  return null;
}

/** `POST /v1/labels/{kind}/{id}/merge`: every document carrying this one carries `into` instead. */
export interface LabelMergeBody {
  readonly into: number;
}

function validLabelName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.trim() === name &&
    name.length <= MAX_LABEL_NAME
  );
}

function validColour(colour: unknown): colour is string {
  return typeof colour === 'string' && LABEL_COLOUR_PATTERN.test(colour);
}

const LABEL_KEYS = ['name', 'colour', 'matching', 'inbox', 'parent'];

function validExtras(body: Record<string, unknown>): boolean {
  return (
    (body['matching'] === undefined || matchingRuleProblem(body['matching']) === null) &&
    (body['inbox'] === undefined || typeof body['inbox'] === 'boolean') &&
    (body['parent'] === undefined ||
      body['parent'] === null ||
      (Number.isSafeInteger(body['parent']) && (body['parent'] as number) > 0))
  );
}

export function isLabelBody(value: unknown): value is LabelBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !LABEL_KEYS.includes(key))) return false;
  if (!validExtras(body)) return false;
  return (
    validLabelName(body['name']) && (body['colour'] === undefined || validColour(body['colour']))
  );
}

export function isLabelPatch(value: unknown): value is LabelPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !LABEL_KEYS.includes(key))) return false;
  if (!validExtras(body)) return false;
  if (body['name'] !== undefined && !validLabelName(body['name'])) return false;
  const colour = body['colour'];
  return colour === undefined || colour === null || validColour(colour);
}

export function isLabelMergeBody(value: unknown): value is LabelMergeBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const into = (value as Record<string, unknown>)['into'];
  return Object.keys(value).length === 1 && Number.isSafeInteger(into) && (into as number) > 0;
}

export function isApplyRulesBody(value: unknown): value is ApplyRulesBody {
  return isTrashActionBody(value);
}

/** The kind a path segment names, or null. */
export function labelKindOf(segment: string): LabelKind | null {
  return LABEL_KINDS.find((kind) => LABEL_SEGMENTS[kind] === segment) ?? null;
}

/** One change, made to every document in a bulk edit. */
export type BulkAction =
  | { readonly kind: 'setCorrespondent'; readonly value: string | null }
  | { readonly kind: 'setDocumentType'; readonly value: string | null }
  | {
      readonly kind: 'modifyTags';
      readonly add: readonly string[];
      readonly remove: readonly string[];
    }
  | {
      readonly kind: 'setCustomField';
      readonly field: number;
      readonly value: CustomFieldData | null;
    }
  | { readonly kind: 'removeCustomField'; readonly field: number }
  | { readonly kind: 'applyRules' }
  | { readonly kind: 'trash' };

export const MAX_BULK_DOCUMENTS = 1_000;

/** `POST /v1/documents/bulk`. */
export interface BulkEditBody {
  readonly documents: readonly string[];
  readonly action: BulkAction;
}

export interface BulkEditResponse {
  /** Documents the action changed; those it found already so, or did not hold, are left out. */
  readonly changed: number;
}

function labelOrNull(value: unknown): boolean {
  return value === null || validLabelName(value);
}

function labelList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_FILTER_VALUES && value.every(validLabelName);
}

function isBulkAction(value: unknown): value is BulkAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  const keys = (...allowed: string[]) =>
    Object.keys(action).every((key) => key === 'kind' || allowed.includes(key));
  const fieldId = (id: unknown) => Number.isSafeInteger(id) && (id as number) > 0;
  switch (action['kind']) {
    case 'setCorrespondent':
    case 'setDocumentType':
      return keys('value') && labelOrNull(action['value']);
    case 'modifyTags':
      return (
        keys('add', 'remove') &&
        labelList(action['add']) &&
        labelList(action['remove']) &&
        action['add'].length + action['remove'].length > 0
      );
    case 'setCustomField':
      return keys('field', 'value') && fieldId(action['field']) && action['value'] !== undefined;
    case 'removeCustomField':
      return keys('field') && fieldId(action['field']);
    case 'applyRules':
    case 'trash':
      return keys();
    default:
      return false;
  }
}

export function isBulkEditBody(value: unknown): value is BulkEditBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const documents = body['documents'];
  return (
    Object.keys(body).every((key) => key === 'documents' || key === 'action') &&
    Array.isArray(documents) &&
    documents.length > 0 &&
    documents.length <= MAX_BULK_DOCUMENTS &&
    documents.every((id) => typeof id === 'string' && isSha256(id)) &&
    isBulkAction(body['action'])
  );
}

/** A share link's secret part: 32 URL-safe characters, 192 random bits. */
export const SHARE_SLUG_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export const MAX_SHARE_DAYS = 3650;

/** A link that opens one document without a token, until it expires or is revoked. */
export interface ShareLink {
  readonly id: number;
  readonly sha256: string;
  readonly slug: string;
  readonly createdAt: number;
  /** Null: until revoked. */
  readonly expiresAt: number | null;
}

export interface ShareLinksResponse {
  /** Newest first. */
  readonly links: readonly ShareLink[];
}

/** `POST /v1/documents/{sha256}/share-links`. No `expiresInDays`: until revoked. */
export interface ShareLinkBody {
  readonly expiresInDays?: number | null;
}

export function isShareLinkBody(value: unknown): value is ShareLinkBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'expiresInDays')) return false;
  const days = body['expiresInDays'];
  return (
    days === undefined ||
    days === null ||
    (Number.isSafeInteger(days) && (days as number) >= 1 && (days as number) <= MAX_SHARE_DAYS)
  );
}

/**
 * When a workflow runs: as a new document is filed, after a person edits one, or
 * once for each document as it reaches an age (`scheduled`, see `olderThanDays`).
 */
export const WORKFLOW_TRIGGERS = ['added', 'updated', 'scheduled'] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

/** Which documents a workflow is for. Every part given must hold. */
export interface WorkflowConditions {
  readonly tags?: readonly string[];
  readonly anyTags?: readonly string[];
  readonly notTags?: readonly string[];
  readonly correspondent?: string;
  readonly documentType?: string;
  /** A rule over the document's text, as a label's (`none` is not allowed here). */
  readonly text?: MatchingRule;
  /** Scheduled only: run once a document is this many days old. Required for `scheduled`. */
  readonly olderThanDays?: number;
  /** Scheduled only: counted from when it arrived (the default) or from its date. */
  readonly dateField?: 'added' | 'created';
}

/** What a workflow does to each document it is for, in this order. */
export interface WorkflowActions {
  /** The same placeholders as file names, e.g. `{{correspondent}} {{created}}`. */
  readonly title?: string;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  /** `null` clears it. */
  readonly correspondent?: string | null;
  readonly documentType?: string | null;
  readonly customField?: { readonly field: number; readonly value: CustomFieldData | null };
  /** POSTed the document's record as JSON; a failure is logged, never retried. */
  readonly webhook?: string;
  /** An email, with the same placeholders as titles; needs the server's SMTP settings. */
  readonly email?: {
    readonly to: readonly string[];
    readonly subject: string;
    readonly body: string;
    /** Attach the PDF. */
    readonly attach: boolean;
  };
}

export const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export interface Workflow {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: WorkflowTrigger;
  readonly conditions: WorkflowConditions;
  readonly actions: WorkflowActions;
  /** Smaller runs first. */
  readonly position: number;
}

export interface WorkflowsResponse {
  readonly workflows: readonly Workflow[];
}

export interface WorkflowBody {
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: WorkflowTrigger;
  readonly conditions: WorkflowConditions;
  readonly actions: WorkflowActions;
  readonly position?: number;
}

/** Placeholders a title template or file name may use. */
export const TEMPLATE_PLACEHOLDERS = [
  'title',
  'correspondent',
  'document_type',
  'tag_list',
  'created',
  'created_year',
  'created_month',
  'created_day',
  'added',
  'added_year',
  'asn',
  'sha256',
] as const;

/** Why a template cannot be used, or null. An unknown placeholder is refused, not left in. */
export function templateProblem(template: string): string | null {
  if (template.trim() === '') return 'the template is empty';
  for (const match of template.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(match[1] ?? '')) {
      return `unknown placeholder {{${match[1] ?? ''}}}; use ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`;
    }
  }
  return null;
}

/** Why a workflow body cannot be used, or null. */
export function workflowProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'body must be a JSON object';
  }
  const body = value as Record<string, unknown>;
  const allowed = ['name', 'enabled', 'trigger', 'conditions', 'actions', 'position'];
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra !== undefined) return `unknown key "${extra}"`;
  if (!validLabelName(body['name']))
    return 'name must be non-empty text without surrounding spaces';
  if (typeof body['enabled'] !== 'boolean') return 'enabled must be true or false';
  if (!(WORKFLOW_TRIGGERS as readonly unknown[]).includes(body['trigger'])) {
    return `trigger must be one of ${WORKFLOW_TRIGGERS.join(', ')}`;
  }
  const position = body['position'];
  if (
    position !== undefined &&
    !(Number.isSafeInteger(position) && Math.abs(position as number) < 1e9)
  ) {
    return 'position must be a whole number';
  }

  const conditions = body['conditions'];
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) {
    return 'conditions must be an object';
  }
  const c = conditions as Record<string, unknown>;
  const conditionKeys = [
    'tags',
    'anyTags',
    'notTags',
    'correspondent',
    'documentType',
    'text',
    'olderThanDays',
    'dateField',
  ];
  const extraCondition = Object.keys(c).find((key) => !conditionKeys.includes(key));
  if (extraCondition !== undefined) return `unknown condition "${extraCondition}"`;
  for (const key of ['tags', 'anyTags', 'notTags']) {
    if (c[key] !== undefined && !labelList(c[key])) return `${key} must be a list of names`;
  }
  for (const key of ['correspondent', 'documentType']) {
    if (c[key] !== undefined && !validLabelName(c[key])) return `${key} must be a name`;
  }
  const days = c['olderThanDays'];
  if (body['trigger'] === 'scheduled') {
    if (!(Number.isInteger(days) && (days as number) >= 0 && (days as number) <= 36_500)) {
      return 'a scheduled workflow needs olderThanDays: a whole number of days';
    }
    if (
      c['dateField'] !== undefined &&
      c['dateField'] !== 'added' &&
      c['dateField'] !== 'created'
    ) {
      return 'dateField must be added or created';
    }
  } else if (days !== undefined || c['dateField'] !== undefined) {
    return 'olderThanDays and dateField are for scheduled workflows';
  }
  if (c['text'] !== undefined) {
    const problem = matchingRuleProblem(c['text']);
    if (problem !== null) return `text: ${problem}`;
    if ((c['text'] as MatchingRule).algorithm === 'none')
      return 'text: leave it out instead of none';
  }

  const actions = body['actions'];
  if (typeof actions !== 'object' || actions === null || Array.isArray(actions)) {
    return 'actions must be an object';
  }
  const a = actions as Record<string, unknown>;
  const actionKeys = [
    'title',
    'addTags',
    'removeTags',
    'correspondent',
    'documentType',
    'customField',
    'webhook',
    'email',
  ];
  const extraAction = Object.keys(a).find((key) => !actionKeys.includes(key));
  if (extraAction !== undefined) return `unknown action "${extraAction}"`;
  if (Object.keys(a).length === 0) return 'a workflow needs at least one action';
  if (a['title'] !== undefined) {
    if (typeof a['title'] !== 'string') return 'title must be a template';
    const problem = templateProblem(a['title']);
    if (problem !== null) return `title: ${problem}`;
  }
  for (const key of ['addTags', 'removeTags']) {
    if (a[key] !== undefined && !labelList(a[key])) return `${key} must be a list of names`;
  }
  for (const key of ['correspondent', 'documentType']) {
    if (a[key] !== undefined && !labelOrNull(a[key])) return `${key} must be a name or null`;
  }
  const field = a['customField'];
  if (field !== undefined) {
    if (typeof field !== 'object' || field === null) return 'customField must be {field, value}';
    const f = field as Record<string, unknown>;
    if (
      !(Number.isSafeInteger(f['field']) && (f['field'] as number) > 0) ||
      f['value'] === undefined
    ) {
      return 'customField must be {field: <id>, value}';
    }
  }
  const email = a['email'];
  if (email !== undefined) {
    if (typeof email !== 'object' || email === null)
      return 'email must be {to, subject, body, attach}';
    const e = email as Record<string, unknown>;
    const to = e['to'];
    if (
      !Array.isArray(to) ||
      to.length === 0 ||
      to.length > 20 ||
      !to.every((address) => typeof address === 'string' && EMAIL_PATTERN.test(address))
    ) {
      return 'email.to must be one to twenty email addresses';
    }
    for (const key of ['subject', 'body']) {
      if (typeof e[key] !== 'string') return `email.${key} must be a template`;
      const problem = templateProblem(e[key]);
      if (problem !== null) return `email.${key}: ${problem}`;
    }
    if (typeof e['attach'] !== 'boolean') return 'email.attach must be true or false';
  }
  const webhook = a['webhook'];
  if (webhook !== undefined) {
    if (typeof webhook !== 'string') return 'webhook must be a URL';
    try {
      const url = new URL(webhook);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return 'webhook must be http or https';
    } catch {
      return 'webhook must be a URL';
    }
  }
  return null;
}

/**
 * What a signed-in person may do. `admin`: everything the admin token can.
 * `editor`: what a paired phone can, reading and changing documents. `viewer`:
 * read only.
 */
export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const MIN_PASSWORD_LENGTH = 10;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface User {
  readonly id: number;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
  /** Null while the user may sign in. */
  readonly disabledAt: number | null;
  readonly lastSignIn: number | null;
}

export interface UsersResponse {
  readonly users: readonly User[];
}

/** `POST /v1/users`. Usernames are lower case: letters, digits, `.`, `_`, `-`. */
export interface UserBody {
  readonly username: string;
  readonly password: string;
  readonly role: Role;
}

export interface UserPatch {
  readonly password?: string;
  readonly role?: Role;
  readonly disabled?: boolean;
}

/** `POST /v1/sessions`. */
export interface SessionBody {
  readonly username: string;
  readonly password: string;
}

export interface SessionResponse {
  /** A bearer token, like the admin token, that ends at `expiresAt`. */
  readonly token: string;
  readonly expiresAt: number;
  readonly user: User;
}

export interface SsoResponse {
  readonly enabled: boolean;
  /** What to call the provider on a button, e.g. "Sign in with Keycloak". */
  readonly name: string | null;
}

/** `GET /v1/me`. */
export interface Me {
  readonly kind: 'admin-token' | 'device' | 'user';
  /** The user's id, for a user. */
  readonly id: number | null;
  readonly role: Role;
  /** For a user; for a device, its name. */
  readonly name: string | null;
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= 1024;
}

export function isUserBody(value: unknown): value is UserBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).every((key) => ['username', 'password', 'role'].includes(key)) &&
    typeof body['username'] === 'string' &&
    USERNAME_PATTERN.test(body['username']) &&
    validPassword(body['password']) &&
    (ROLES as readonly unknown[]).includes(body['role'])
  );
}

export function isUserPatch(value: unknown): value is UserPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).every((key) => ['password', 'role', 'disabled'].includes(key)) &&
    (body['password'] === undefined || validPassword(body['password'])) &&
    (body['role'] === undefined || (ROLES as readonly unknown[]).includes(body['role'])) &&
    (body['disabled'] === undefined || typeof body['disabled'] === 'boolean')
  );
}

export function isSessionBody(value: unknown): value is SessionBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body['username'] === 'string' &&
    body['username'].length <= 64 &&
    typeof body['password'] === 'string' &&
    body['password'].length <= 1024
  );
}

/** One change someone made through the API. */
export interface AuditEntry {
  readonly id: number;
  readonly at: number;
  /** A username, a phone's name, or "admin token". */
  readonly who: string;
  /** What was done, in a few words. */
  readonly what: string;
  /** The document it was done to, when there was one. */
  readonly sha256: string | null;
}

export interface AuditResponse {
  /** Newest first. Ask again with `before` set to the last id for older ones. */
  readonly entries: readonly AuditEntry[];
}

/** A page of an edited document: which page it was (from 1), and how far to turn it clockwise. */
export interface PageSpec {
  readonly page: number;
  readonly rotate?: 0 | 90 | 180 | 270;
}

export const MAX_PAGES = 2_000;

/**
 * `POST /v1/documents/{sha256}/pages`: the pages the document should have, in
 * order. Leaving a page out removes it. The answer is the document, now under the
 * new file's hash; the old file is kept as an earlier version.
 */
export interface PagesBody {
  readonly pages: readonly PageSpec[];
}

export interface PageCountResponse {
  readonly pages: number;
}

/** `POST /v1/documents/{sha256}/split`. By default the original goes to the trash. */
export interface SplitBody {
  readonly parts: readonly (readonly number[])[];
  readonly keepOriginal?: boolean;
}

/** `POST /v1/documents/merge`, in reading order. By default the originals go to the trash. */
export interface MergeBody {
  readonly documents: readonly string[];
  readonly keepOriginals?: boolean;
}

export interface NewDocumentsResponse {
  readonly documents: readonly string[];
}

export interface DocumentVersion {
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number | null;
  /** When the document moved on from this file. */
  readonly replacedAt: number;
}

export interface VersionsResponse {
  /** Newest first. */
  readonly versions: readonly DocumentVersion[];
}

function isPageNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PAGES;
}

export function isPagesBody(value: unknown): value is PagesBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pages = (value as Record<string, unknown>)['pages'];
  return (
    Array.isArray(pages) &&
    pages.length > 0 &&
    pages.length <= MAX_PAGES &&
    pages.every((spec: unknown) => {
      if (typeof spec !== 'object' || spec === null) return false;
      const s = spec as Record<string, unknown>;
      return (
        Object.keys(s).every((key) => key === 'page' || key === 'rotate') &&
        isPageNumber(s['page']) &&
        (s['rotate'] === undefined || [0, 90, 180, 270].includes(s['rotate'] as number))
      );
    })
  );
}

export const STAMP_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
export type StampPosition = (typeof STAMP_POSITIONS)[number];
export const STAMP_COLOURS = ['red', 'blue', 'green', 'black'] as const;
export type StampColour = (typeof STAMP_COLOURS)[number];
export const MAX_STAMP_TEXT = 40;

/**
 * `POST /v1/documents/{sha256}/stamp`: words such as PAID or RECEIVED drawn in a
 * box on the page, as a rubber stamp would. Like a page edit, the document moves to
 * the stamped file and the unstamped one is kept as an earlier version.
 */
export interface StampBody {
  /** Latin letters, digits and punctuation, up to `MAX_STAMP_TEXT`. */
  readonly text: string;
  /** Today's date under the words, as the server sees it. Default true. */
  readonly withDate?: boolean;
  /** Default `top-right`, as the page is seen, whichever way it is turned. */
  readonly position?: StampPosition;
  /** Default `red`. */
  readonly colour?: StampColour;
  /** Only the first page, the default, or every page. */
  readonly pages?: 'first' | 'all';
}

export function stampProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'body must be a JSON object';
  }
  const body = value as Record<string, unknown>;
  const known = ['text', 'withDate', 'position', 'colour', 'pages'];
  const unknown = Object.keys(body).find((key) => !known.includes(key));
  if (unknown !== undefined) return `unknown field "${unknown}"`;
  const text = body['text'];
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_STAMP_TEXT) {
    return `text must be 1 to ${String(MAX_STAMP_TEXT)} characters`;
  }
  // The stamp's font has Latin letters only; anything else could not be drawn.
  if (!/^[\x20-\x7E\u00A0-\u00FF]+$/.test(text)) {
    return 'text can use Latin letters, digits and punctuation only';
  }
  if (body['withDate'] !== undefined && typeof body['withDate'] !== 'boolean') {
    return 'withDate must be true or false';
  }
  if (
    body['position'] !== undefined &&
    !(STAMP_POSITIONS as readonly unknown[]).includes(body['position'])
  ) {
    return `position must be one of ${STAMP_POSITIONS.join(', ')}`;
  }
  if (
    body['colour'] !== undefined &&
    !(STAMP_COLOURS as readonly unknown[]).includes(body['colour'])
  ) {
    return `colour must be one of ${STAMP_COLOURS.join(', ')}`;
  }
  if (body['pages'] !== undefined && body['pages'] !== 'first' && body['pages'] !== 'all') {
    return 'pages must be "first" or "all"';
  }
  return null;
}

export function isSplitBody(value: unknown): value is SplitBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const parts = body['parts'];
  return (
    Object.keys(body).every((key) => key === 'parts' || key === 'keepOriginal') &&
    Array.isArray(parts) &&
    parts.length >= 1 &&
    parts.length <= 200 &&
    parts.every(
      (part: unknown) => Array.isArray(part) && part.length > 0 && part.every(isPageNumber),
    ) &&
    (body['keepOriginal'] === undefined || typeof body['keepOriginal'] === 'boolean')
  );
}

export function isMergeBody(value: unknown): value is MergeBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const documents = body['documents'];
  return (
    Object.keys(body).every((key) => key === 'documents' || key === 'keepOriginals') &&
    Array.isArray(documents) &&
    documents.length >= 2 &&
    documents.length <= 100 &&
    new Set(documents).size === documents.length &&
    documents.every((id) => typeof id === 'string' && isSha256(id)) &&
    (body['keepOriginals'] === undefined || typeof body['keepOriginals'] === 'boolean')
  );
}

/** "1-3, 5" as pages [1, 2, 3, 5]; null for anything else. */
export function parsePageList(text: string): number[] | null {
  const pages: number[] = [];
  for (const piece of text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from < 1 || to < from || to - from > MAX_PAGES) return null;
      for (let page = from; page <= to; page++) pages.push(page);
    } else if (/^\d+$/.test(piece) && Number(piece) >= 1) {
      pages.push(Number(piece));
    } else {
      return null;
    }
  }
  return pages.length === 0 ? null : pages;
}

/** What an admin can change while the server runs. */
export interface ServerSettings {
  /** Days a deleted document waits in the trash. At least 1. */
  readonly trashDays: number;
  /** How exported files are named; see `TEMPLATE_PLACEHOLDERS`. */
  readonly filenameFormat: string;
  /** Read barcodes on new documents: separator pages and archive serial numbers. */
  readonly barcodesEnabled: boolean;
  /** A page whose barcode reads exactly this splits the document there, and is dropped. */
  readonly barcodeSeparator: string;
  /** A barcode starting with this, then digits, sets the archive serial number. */
  readonly barcodeAsnPrefix: string;
  /** How a date written in numbers alone is read: 03/04/2026 is 3 April in DMY, March 4 in MDY. */
  readonly dateOrder: DateOrderSetting;
  /** The currency an amount with no currency written beside it is taken to be in. ISO 4217. */
  readonly defaultCurrency: string;
}

export const DATE_ORDERS = ['DMY', 'MDY', 'YMD'] as const;
export type DateOrderSetting = (typeof DATE_ORDERS)[number];

export const SETTING_KEYS = [
  'trashDays',
  'filenameFormat',
  'barcodesEnabled',
  'barcodeSeparator',
  'barcodeAsnPrefix',
  'dateOrder',
  'defaultCurrency',
] as const;

/** Where a setting's value comes from: built in, the environment, or saved by an admin. */
export type SettingSource = 'default' | 'environment' | 'saved';

export interface SettingsResponse {
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<keyof ServerSettings, SettingSource>>;
}

/** Each key given is saved; `null` forgets the saved value and goes back to the environment's. */
export type SettingsPatch = {
  readonly [K in keyof ServerSettings]?: ServerSettings[K] | null;
};

/** Why a value cannot be used for a setting, or null. */
export function settingProblem(key: string, value: unknown): string | null {
  if (value === null) return null;
  switch (key) {
    case 'trashDays':
      return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 3650
        ? null
        : 'trashDays must be a number of days from 1 to 3650';
    case 'filenameFormat':
      return typeof value === 'string' ? templateProblem(value) : 'filenameFormat must be text';
    case 'barcodesEnabled':
      return typeof value === 'boolean' ? null : 'barcodesEnabled must be true or false';
    case 'barcodeSeparator':
    case 'barcodeAsnPrefix':
      return typeof value === 'string' && value.trim() !== '' && value.length <= 64
        ? null
        : `${key} must be text of at most 64 characters`;
    case 'dateOrder':
      return (DATE_ORDERS as readonly unknown[]).includes(value)
        ? null
        : 'dateOrder must be DMY, MDY or YMD';
    case 'defaultCurrency':
      return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
        ? null
        : 'defaultCurrency must be a three-letter currency code, such as EUR';
    default:
      return `there is no setting "${key}"`;
  }
}

export function settingsPatchProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'body must be a JSON object';
  }
  for (const [key, setting] of Object.entries(value)) {
    const problem = settingProblem(key, setting);
    if (problem !== null) return problem;
  }
  return null;
}

/** What another user may do with a document: read it, or read and change it. */
export type AccessLevel = 'view' | 'change';

export interface DocumentPermissions {
  /** Null: shared with everyone, as documents were before there were users. */
  readonly owner: number | null;
  /** Others the owner shared it with. */
  readonly grants: readonly { readonly user: number; readonly level: AccessLevel }[];
}

export interface UserDirectoryResponse {
  readonly users: readonly { readonly id: number; readonly username: string }[];
}

export function isDocumentPermissions(value: unknown): value is DocumentPermissions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const owner = body['owner'];
  const grants = body['grants'];
  const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  return (
    Object.keys(body).every((key) => key === 'owner' || key === 'grants') &&
    (owner === null || id(owner)) &&
    Array.isArray(grants) &&
    grants.length <= 200 &&
    grants.every((grant: unknown) => {
      if (typeof grant !== 'object' || grant === null) return false;
      const g = grant as Record<string, unknown>;
      return id(g['user']) && (g['level'] === 'view' || g['level'] === 'change');
    }) &&
    new Set(grants.map((g: { user: number }) => g.user)).size === grants.length
  );
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
