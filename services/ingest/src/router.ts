import { timingSafeEqual } from 'node:crypto';
import type { FailureReason } from '@sheaf/core';
import type { ArchivePatch, DocumentQuery } from '@sheaf/paperless';
import {
  DOCUMENT_CONTENT_TYPE,
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  PROTOCOL_VERSION,
  bearerToken,
  isPaperlessId,
  isSha256,
  paths,
  type ArchiveSearchResponse,
  type ArchiveVocabulary,
  type DocumentPatch,
  type ErrorCode,
  type HealthResponse,
  type ListResponse,
  type ReconciliationProbe,
  type SuggestionsResponse,
} from '@sheaf/protocol';
import type { ArchiveSource } from './paperless-browse.ts';
import type { Storage } from './storage.ts';
import { sha256Hex } from './storage.ts';

/**
 * Every route, as a pure function of a parsed request.
 *
 * Nothing here touches a socket, so each route is tested directly rather than
 * through an HTTP client — the same split the client uses between deciding and
 * performing.
 */
export interface IngestRequest {
  readonly method: string;
  readonly path: string;
  /** Raw query string, without the leading `?`. Empty when there was none. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export interface IngestResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
}

export interface RouterDeps {
  readonly storage: Storage;
  readonly token: string;
  readonly now: () => number;
  /** Host of the downstream system, when one is configured. */
  readonly forwardingTo?: string;
  /**
   * The one-time filter probe, read live rather than passed as a value: it resolves
   * asynchronously after the server is already accepting requests, so `/v1/health`
   * has to see whatever the latest call left behind, including "not yet".
   */
  readonly reconciliation?: () => ReconciliationProbe | null;
  /** Absent exactly when forwarding is not configured -- there is nothing to browse. */
  readonly archive?: ArchiveSource;
}

const fail = (error: ErrorCode, detail?: string): IngestResponse => ({
  status: ERROR_STATUS[error],
  json: detail === undefined ? { error } : { error, detail },
});

/** Constant-time comparison, so a wrong token leaks nothing through timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handle(request: IngestRequest, deps: RouterDeps): Promise<IngestResponse> {
  const provided = bearerToken(request.headers['authorization']);
  if (provided === null || !tokenMatches(provided, deps.token)) {
    return fail('unauthenticated');
  }

  const { method, path } = request;

  if (path === paths.health()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const reconciliation = deps.reconciliation?.() ?? null;
    const health: HealthResponse = {
      name: 'sheaf-ingest',
      protocol: PROTOCOL_VERSION,
      documents: await deps.storage.count(),
      ...(deps.forwardingTo === undefined
        ? {}
        : {
            forwarding: {
              target: deps.forwardingTo,
              counts: await deps.storage.forwardCounts(),
              ...(reconciliation === null ? {} : { reconciliation }),
            },
          }),
    };
    return { status: 200, json: health };
  }

  if (path === paths.documents()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const list: ListResponse = { documents: await deps.storage.list() };
    return { status: 200, json: list };
  }

  if (path === paths.archive() || path.startsWith(`${paths.archive()}/`)) {
    return archive(path, request, deps);
  }

  const prefix = `${paths.documents()}/`;
  if (!path.startsWith(prefix)) return fail('not_found');
  const rest = path.slice(prefix.length);

  const suggestionsSuffix = '/suggestions';
  if (rest.endsWith(suggestionsSuffix)) {
    const id = rest.slice(0, -suggestionsSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const record = await deps.storage.record(id);
    if (record === null) return fail('not_found');
    const response: SuggestionsResponse = { suggestions: record.suggestions };
    return { status: 200, json: response };
  }

  const id = rest;
  // An identifier that is not a hash never reaches storage, so traversal is
  // impossible by construction rather than by sanitising a string.
  if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');

  switch (method) {
    case 'PUT':
      return put(id, request, deps);
    case 'HEAD':
      return (await deps.storage.has(id)) ? { status: 200 } : { status: ERROR_STATUS.not_found };
    case 'GET': {
      const bytes = deps.storage.bytes(id);
      if (bytes !== null) {
        return { status: 200, headers: { 'content-type': DOCUMENT_CONTENT_TYPE }, bytes };
      }
      // The bytes can be missing for two different reasons, and only one of them is
      // "never happened": a document retention has released still has a row, and
      // deserves 410, not the 404 that would send someone looking for a typo.
      const record = await deps.storage.record(id);
      if (record?.bytesReleased === true) {
        return fail(
          'released',
          'retention freed these bytes once Paperless confirmed it has this document',
        );
      }
      return fail('not_found');
    }
    case 'PATCH': {
      const patch = parseJson<DocumentPatch>(request.body);
      if (patch === null) return fail('bad_request', 'body must be a JSON object');
      const record = await deps.storage.patch(id, patch);
      return record === null ? fail('not_found') : { status: 200, json: record };
    }
    default:
      return fail('bad_request', `${method} not allowed here`);
  }
}

async function put(id: string, request: IngestRequest, deps: RouterDeps): Promise<IngestResponse> {
  if (request.body.length === 0) return fail('bad_request', 'empty body');
  if (request.body.length > MAX_DOCUMENT_BYTES) return fail('too_large');

  // The address is a claim about the content. Verify it rather than trust it: this
  // is where a truncated or corrupted upload is caught, before it is stored under
  // an identity it does not have.
  const actual = sha256Hex(request.body);
  if (actual !== id) {
    return fail('hash_mismatch', `body hashes to ${actual}`);
  }

  const pageCount = parsePageCount(request.headers['x-sheaf-page-count']);
  const outcome = await deps.storage.put(id, request.body, deps.now(), pageCount);
  const record = await deps.storage.record(id);

  // 201 when we stored it, 200 when we already had it. Both are success; a client
  // retrying after a lost response gets 200 and can stop worrying.
  return { status: outcome === 'stored' ? 201 : 200, json: record };
}

/**
 * Everything under `/v1/archive`. One entry point rather than folding this into
 * the switch above: the identifiers here are Paperless's own ids, not the sha256
 * the rest of this router is built around, and mixing the two validators in one
 * place invites checking a document id against the wrong pattern.
 */
async function archive(
  path: string,
  request: IngestRequest,
  deps: RouterDeps,
): Promise<IngestResponse> {
  if (deps.archive === undefined) {
    return fail('archive_disabled', 'set PAPERLESS_URL to browse the archive from this server');
  }
  const source = deps.archive;
  const { method } = request;

  if (path === paths.archive()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const params = new URLSearchParams(request.query);
    const query: DocumentQuery = {
      ...(params.get('query') === null ? {} : { text: params.get('query')! }),
      ...(params.get('page') === null ? {} : { page: Number(params.get('page')) }),
      ...(params.get('correspondent') === null
        ? {}
        : { correspondentId: Number(params.get('correspondent')) }),
      ...(params.get('documentType') === null
        ? {}
        : { documentTypeId: Number(params.get('documentType')) }),
      ...(params.get('tag') === null ? {} : { tagId: Number(params.get('tag')) }),
    };
    const result = await source.search(query);
    if (!result.ok) return mapArchiveFailure(result.reason);
    const response: ArchiveSearchResponse = { ...result.value };
    return { status: 200, json: response };
  }

  if (path === paths.archiveVocabulary()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const vocabulary: ArchiveVocabulary = await source.vocabulary();
    return { status: 200, json: vocabulary };
  }

  const thumbnailSuffix = '/thumbnail';
  const isThumbnail = path.endsWith(thumbnailSuffix);
  const idPart = isThumbnail
    ? path.slice(paths.archive().length + 1, -thumbnailSuffix.length)
    : path.slice(paths.archive().length + 1);
  if (!isPaperlessId(idPart)) return fail('malformed_id', 'archive ids are positive integers');
  const id = Number(idPart);

  if (isThumbnail) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const result = await source.thumbnail(id);
    if (!result.ok) return mapArchiveFailure(result.reason);
    return {
      status: 200,
      headers: { 'content-type': result.value.contentType },
      bytes: result.value.bytes,
    };
  }

  switch (method) {
    case 'GET': {
      const result = await source.get(id);
      return result.ok ? { status: 200, json: result.value } : mapArchiveFailure(result.reason);
    }
    case 'PATCH': {
      const patch = parseJson<ArchivePatch>(request.body);
      if (patch === null) return fail('bad_request', 'body must be a JSON object');
      const result = await source.patch(id, patch);
      return result.ok ? { status: 200, json: result.value } : mapArchiveFailure(result.reason);
    }
    default:
      return fail('bad_request', `${method} not allowed here`);
  }
}

/**
 * Paperless's own refusal, translated. `not_found` is worth telling apart --
 * a stale or mistyped id is the ordinary case -- everything else collapses to
 * `server_error` rather than inventing a taxonomy for failures this server did
 * not cause and cannot fix on the caller's behalf.
 */
function mapArchiveFailure(reason: FailureReason): IngestResponse {
  if (reason.kind === 'not_found') return fail('not_found');
  return fail('server_error', `the downstream system could not complete this: ${reason.kind}`);
}

function parseJson<T>(body: Uint8Array): T | null {
  if (body.length === 0) return {} as T;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    // `typeof [] === 'object'`, so an array would slip through a naive check and be
    // treated as a patch with no fields.
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

function parsePageCount(header: string | undefined): number | null {
  if (header === undefined) return null;
  const value = Number(header);
  return Number.isInteger(value) && value > 0 ? value : null;
}
