import { timingSafeEqual } from 'node:crypto';
import type { FailureReason } from '@sheaf/core';
import type { ArchivePatch, DocumentQuery } from '@sheaf/paperless';
import {
  DOCUMENT_CONTENT_TYPE,
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  MAX_TEXT_BYTES,
  PROTOCOL_VERSION,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  bearerToken,
  isDocumentTextBody,
  isPaperlessId,
  isSha256,
  paths,
  type ArchiveSearchResponse,
  type ArchiveVocabulary,
  type DocumentPatch,
  type ErrorCode,
  type HealthResponse,
  type ListResponse,
  type DevicesResponse,
  type FieldsResponse,
  type HistoryResponse,
  type InboxResponse,
  type PairRequest,
  type PairResponse,
  type PairingCodeResponse,
  type ReconciliationProbe,
  type SearchResponse,
  type SuggestionsResponse,
} from '@sheaf/protocol';
import type { ArchiveSource } from './paperless-browse.ts';
import type { Devices } from './devices.ts';
import { toMatch } from './search-query.ts';
import type { Storage } from './storage.ts';
import { PRIMARY_CONNECTOR, sha256Hex } from './storage.ts';

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
  /** Who is asking, for rate-limiting the one route that needs no token. */
  readonly remoteAddress?: string;
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
  /** Static once the process starts -- see SHEAF_RETENTION_DAYS. Absent means off. */
  readonly retentionDays?: number;
  /** Paired phones (ADR 0008). Absent, only the admin token is accepted. */
  readonly devices?: Devices;
}

/** Who a request is from: the operator's admin token, or one paired phone. */
type Principal = { readonly kind: 'admin' } | { readonly kind: 'device'; readonly id: string };

/** At most this many pairing attempts per address per minute. Codes cannot be guessed
 * anyway (128 bits); this keeps a guessing loop out of the logs. */
const PAIR_ATTEMPTS_PER_MINUTE = 10;
const pairAttempts = new WeakMap<Devices, Map<string, number[]>>();

const fail = (error: ErrorCode, detail?: string): IngestResponse => ({
  status: ERROR_STATUS[error],
  json: detail === undefined ? { error } : { error, detail },
});

async function authenticate(
  request: IngestRequest,
  deps: RouterDeps,
): Promise<Principal | 'revoked' | null> {
  const provided = bearerToken(request.headers['authorization']);
  if (provided === null) return null;
  if (tokenMatches(provided, deps.token)) return { kind: 'admin' };
  const device = await deps.devices?.authenticate(provided);
  if (device === undefined || device === null) return null;
  return device.kind === 'revoked' ? 'revoked' : { kind: 'device', id: device.id };
}

async function pair(
  request: IngestRequest,
  devices: Devices,
  now: number,
): Promise<IngestResponse> {
  const address = request.remoteAddress ?? 'unknown';
  let attempts = pairAttempts.get(devices);
  if (attempts === undefined) {
    attempts = new Map();
    pairAttempts.set(devices, attempts);
  }
  const recent = (attempts.get(address) ?? []).filter((at) => now - at < 60_000);
  recent.push(now);
  attempts.set(address, recent);
  if (recent.length > PAIR_ATTEMPTS_PER_MINUTE) return fail('rate_limited');

  const body = parseJson<Partial<PairRequest>>(request.body);
  if (body === null || typeof body.code !== 'string' || typeof body.deviceName !== 'string') {
    return fail('bad_request', 'body must be {"code": "...", "deviceName": "..."}');
  }
  const paired = await devices.pair(body.code, body.deviceName);
  if (paired === null) return fail('pairing_invalid', 'that code is unknown, used or expired');
  const response: PairResponse = paired;
  return { status: 200, json: response };
}

async function manageDevices(request: IngestRequest, devices: Devices): Promise<IngestResponse> {
  const { method, path } = request;
  if (path === paths.pairingCodes()) {
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const response: PairingCodeResponse = await devices.createPairingCode();
    return { status: 201, json: response };
  }
  if (path === paths.devices()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const response: DevicesResponse = { devices: await devices.list() };
    return { status: 200, json: response };
  }
  const id = path.slice(paths.devices().length + 1);
  if (method !== 'DELETE') return fail('bad_request', `${method} not allowed here`);
  return (await devices.revoke(id)) ? { status: 204 } : fail('not_found');
}

/** Constant-time comparison, so a wrong token leaks nothing through timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handle(request: IngestRequest, deps: RouterDeps): Promise<IngestResponse> {
  const { method, path } = request;

  // The one route a stranger may call: they hold a pairing code, not yet a token.
  if (path === paths.pair() && deps.devices !== undefined) {
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    return pair(request, deps.devices, deps.now());
  }

  const principal = await authenticate(request, deps);
  if (principal === 'revoked') {
    return fail('device_revoked', 'this device was removed; pair it again to keep syncing');
  }
  if (principal === null) return fail('unauthenticated');

  if (
    path === paths.pairingCodes() ||
    path === paths.devices() ||
    path.startsWith(`${paths.devices()}/`)
  ) {
    if (principal.kind !== 'admin')
      return fail('forbidden', 'only the admin token manages devices');
    if (deps.devices === undefined) return fail('not_found');
    return manageDevices(request, deps.devices);
  }

  if (path === paths.health()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const reconciliation = deps.reconciliation?.() ?? null;
    const retention =
      deps.retentionDays === undefined
        ? null
        : { days: deps.retentionDays, released: await deps.storage.releasedCount() };
    const health: HealthResponse = {
      name: 'sheaf-ingest',
      protocol: PROTOCOL_VERSION,
      documents: await deps.storage.count(),
      ...(deps.forwardingTo === undefined
        ? {}
        : {
            forwarding: {
              target: deps.forwardingTo,
              counts: await deps.storage.forwardCounts(PRIMARY_CONNECTOR),
              ...(reconciliation === null ? {} : { reconciliation }),
              ...(retention === null ? {} : { retention }),
            },
          }),
    };
    return { status: 200, json: health };
  }

  if (path === paths.inbox()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const response: InboxResponse = { documents: await deps.storage.inbox() };
    return { status: 200, json: response };
  }

  if (path === paths.search()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    return search(request.query, deps);
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

  for (const [suffix, read] of [
    ['/fields', readFields],
    ['/history', readHistory],
  ] as const) {
    if (!rest.endsWith(suffix)) continue;
    const id = rest.slice(0, -suffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    if (!(await deps.storage.has(id))) return fail('not_found');
    return { status: 200, json: await read(id, deps) };
  }

  const textSuffix = '/text';
  if (rest.endsWith(textSuffix)) {
    const id = rest.slice(0, -textSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (method !== 'PUT') return fail('bad_request', `${method} not allowed here`);
    return putText(id, request, deps);
  }

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
      return put(id, request, deps, principal);
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
      const record = await deps.storage.patch(id, patch, deps.now());
      return record === null ? fail('not_found') : { status: 200, json: record };
    }
    default:
      return fail('bad_request', `${method} not allowed here`);
  }
}

async function put(
  id: string,
  request: IngestRequest,
  deps: RouterDeps,
  principal: Principal,
): Promise<IngestResponse> {
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
  const outcome = await deps.storage.put(
    id,
    request.body,
    deps.now(),
    pageCount,
    principal.kind === 'device' ? principal.id : null,
  );
  const record = await deps.storage.record(id);

  // 201 when we stored it, 200 when we already had it. Both are success; a client
  // retrying after a lost response gets 200 and can stop worrying.
  return { status: outcome === 'stored' ? 201 : 200, json: record };
}

async function readFields(id: string, deps: RouterDeps): Promise<FieldsResponse> {
  return { fields: await deps.storage.fields(id) };
}

async function readHistory(id: string, deps: RouterDeps): Promise<HistoryResponse> {
  return { events: await deps.storage.history(id) };
}

async function search(query: string, deps: RouterDeps): Promise<IngestResponse> {
  const params = new URLSearchParams(query);
  const limit = whole(params.get('limit'), SEARCH_DEFAULT_LIMIT);
  const offset = whole(params.get('offset'), 0);
  if (limit === null || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    return fail(
      'bad_request',
      `limit must be a whole number from 1 to ${String(SEARCH_MAX_LIMIT)}`,
    );
  }
  if (offset === null) return fail('bad_request', 'offset must be a whole number');

  // Anything typed is searchable; text with no words in it simply matches nothing.
  const match = toMatch(params.get('q') ?? '');
  const response: SearchResponse =
    match === null ? { hits: [], hasMore: false } : await deps.storage.search(match, limit, offset);
  return { status: 200, json: response };
}

/** A non-negative integer from a query parameter, the fallback when absent, or null. */
function whole(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

async function putText(
  id: string,
  request: IngestRequest,
  deps: RouterDeps,
): Promise<IngestResponse> {
  if (request.body.length > MAX_TEXT_BYTES) return fail('too_large');
  const body = request.body.length === 0 ? null : parseJson<unknown>(request.body);
  if (!isDocumentTextBody(body)) {
    return fail('bad_request', 'body must be {"source": "edge", "engine": "...", "text": "..."}');
  }
  const outcome = await deps.storage.putText(id, body, deps.now());
  return outcome === 'stored' ? { status: 204 } : fail('not_found');
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
    return fail('archive_disabled', 'the archive chosen by SHEAF_ARCHIVE_SOURCE is not available');
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
  // A request the archive refused as malformed, such as an edit naming a tag that
  // does not exist, is the caller's to fix and says so.
  if (reason.kind === 'rejected' && reason.status === 400) {
    return fail('bad_request', reason.message);
  }
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
