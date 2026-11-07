import { timingSafeEqual } from 'node:crypto';
import type { FailureReason } from '@sheaf/core';
import type { ArchivePatch, DocumentQuery } from '@sheaf/paperless';
import {
  CUSTOM_FIELD_TYPES,
  DOCUMENT_CONTENT_TYPE,
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  MAX_NOTE_LENGTH,
  MAX_TEXT_BYTES,
  PROTOCOL_VERSION,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  bearerToken,
  isCustomFieldBody,
  isCustomFieldPatch,
  isCustomFieldValuesBody,
  isDocumentTextBody,
  isApplyRulesBody,
  isLabelBody,
  isLabelMergeBody,
  isLabelPatch,
  labelKindOf,
  matchingRuleProblem,
  isNoteBody,
  isTrashActionBody,
  isPaperlessId,
  isSha256,
  paths,
  type ArchiveSearchResponse,
  type ArchiveVocabulary,
  type CustomFieldsResponse,
  type DocumentCustomFieldsResponse,
  type DocumentPatch,
  type DocumentRecord,
  type ErrorCode,
  type HealthResponse,
  type ListResponse,
  type DevicesResponse,
  type FieldsResponse,
  type HistoryResponse,
  type InboxResponse,
  type LabelsResponse,
  type ApplyRulesResponse,
  type NotesResponse,
  type PairRequest,
  type PairResponse,
  type PairingCodeResponse,
  type ReconciliationProbe,
  type SearchResponse,
  type SuggestionsResponse,
  type TrashActionResponse,
  type TrashResponse,
} from '@sheaf/protocol';
import type { CustomFieldRefusal, CustomFields } from './custom-fields.ts';
import type { LabelRefusal, Labels } from './labels.ts';
import type { Rules } from './rules.ts';
import type { ArchiveSource } from './paperless-browse.ts';
import type { Devices } from './devices.ts';
import type { ServerMetrics } from './observability.ts';
import { toMatch } from './search-query.ts';
import type { Storage } from './storage.ts';
import { PRIMARY_CONNECTOR, sha256Hex } from './storage.ts';
import { DEFAULT_TRASH_DAYS } from './trash.ts';

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
  /** What `/metrics` reports. Absent, the route does not exist. */
  readonly metrics?: ServerMetrics;
  /** Days a trashed document is kept; see SHEAF_TRASH_DAYS. Absent means the default. */
  readonly trashDays?: number;
  /** Custom field definitions and values. Absent, those routes answer 404. */
  readonly customFields?: CustomFields;
  /** Correspondents, document types and tags. Absent, those routes answer 404. */
  readonly labels?: Labels;
  /** Filing documents by the labels' rules. Absent, applying them answers 404. */
  readonly rules?: Rules;
}

/** Prometheus's conventional path, outside the versioned protocol. */
export const METRICS_PATH = '/metrics';

/** Who a request is from: the operator's admin token, or one paired phone. */
type Principal = { readonly kind: 'admin' } | { readonly kind: 'device'; readonly id: string };

/**
 * At most this many failed pairing attempts per address per minute. Codes cannot be
 * guessed anyway (128 bits); this keeps a guessing loop out of the logs. Successes do
 * not count: pairing a whole household's phones from one network is not guessing.
 */
const PAIR_FAILURES_PER_MINUTE = 10;
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
  const failures = (attempts.get(address) ?? []).filter((at) => now - at < 60_000);
  attempts.set(address, failures);
  if (failures.length >= PAIR_FAILURES_PER_MINUTE) return fail('rate_limited');

  const body = parseJson<Partial<PairRequest>>(request.body);
  if (body === null || typeof body.code !== 'string' || typeof body.deviceName !== 'string') {
    failures.push(now);
    return fail('bad_request', 'body must be {"code": "...", "deviceName": "..."}');
  }
  const paired = await devices.pair(body.code, body.deviceName);
  if (paired === null) {
    failures.push(now);
    return fail('pairing_invalid', 'that code is unknown, used or expired');
  }
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

  if (path === METRICS_PATH && deps.metrics !== undefined) {
    // Admin only: counts of documents and phones are not a paired phone's business.
    if (principal.kind !== 'admin') return fail('forbidden', 'metrics need the admin token');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    return {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      bytes: new Uint8Array(Buffer.from(await deps.metrics.render(deps.now()))),
    };
  }

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

  if (path === paths.customFields() || path.startsWith(`${paths.customFields()}/`)) {
    if (deps.customFields === undefined) return fail('not_found');
    return customFieldDefinitions(request, deps, deps.customFields, principal);
  }

  if (path === paths.labelsApply()) {
    if (deps.rules === undefined) return fail('not_found');
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token applies rules');
    const body = parseJson<unknown>(request.body);
    if (!isApplyRulesBody(body)) {
      return fail('bad_request', 'body must be {} or {"documents": [sha256, ...]}');
    }
    const response: ApplyRulesResponse = { changed: await deps.rules.applyAll(body.documents) };
    return { status: 200, json: response };
  }

  if (path.startsWith(`/${PROTOCOL_VERSION}/labels/`)) {
    if (deps.labels === undefined) return fail('not_found');
    return labelRoutes(request, deps.labels, principal);
  }

  if (path === paths.trash() || path.startsWith(`${paths.trash()}/`)) {
    return trash(request, deps, principal);
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
    ['/record', readRecord],
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

  const customFieldsSuffix = '/custom-fields';
  if (rest.endsWith(customFieldsSuffix)) {
    const id = rest.slice(0, -customFieldsSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (deps.customFields === undefined) return fail('not_found');
    return documentCustomFields(id, request, deps, deps.customFields);
  }

  const notesMatch = /^([^/]+)\/notes(?:\/([^/]+))?$/.exec(rest);
  if (notesMatch !== null) {
    const id = notesMatch[1]!;
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    return notes(id, notesMatch[2], request, deps, principal);
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
    case 'DELETE':
      // To the trash, not gone: see `/v1/trash` for putting it back.
      return (await deps.storage.trash(id, deps.now())) ? { status: 204 } : fail('not_found');
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

/** Defining custom fields is the admin's; anyone may read the definitions. */
async function customFieldDefinitions(
  request: IngestRequest,
  deps: RouterDeps,
  fields: CustomFields,
  principal: Principal,
): Promise<IngestResponse> {
  const { method, path } = request;
  const now = deps.now();
  if (path === paths.customFields()) {
    if (method === 'GET') {
      const response: CustomFieldsResponse = { fields: await fields.list() };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token defines fields');
    const body = parseJson<unknown>(request.body);
    if (!isCustomFieldBody(body)) {
      return fail(
        'bad_request',
        `body must be {"name": "...", "type": one of ${CUSTOM_FIELD_TYPES.join(', ')}}, with "options" for a select`,
      );
    }
    const created = await fields.create(body, now);
    return created.ok ? { status: 201, json: created.value } : refusal(created);
  }

  const idPart = path.slice(paths.customFields().length + 1);
  if (!/^[1-9][0-9]{0,15}$/.test(idPart)) {
    return fail('malformed_id', 'custom field ids are positive integers');
  }
  const id = Number(idPart);
  if (method === 'GET') {
    const field = await fields.get(id);
    return field === null ? fail('not_found') : { status: 200, json: field };
  }
  if (method !== 'PATCH' && method !== 'DELETE') {
    return fail('bad_request', `${method} not allowed here`);
  }
  if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token changes fields');
  if (method === 'DELETE') return (await fields.remove(id)) ? { status: 204 } : fail('not_found');
  const patch = parseJson<unknown>(request.body);
  if (!isCustomFieldPatch(patch)) {
    return fail('bad_request', 'body may hold only "name" and, for a select, "options"');
  }
  const updated = await fields.update(id, patch, now);
  return updated.ok ? { status: 200, json: updated.value } : refusal(updated);
}

/** One document's custom field values: read them, or replace the whole set. */
async function documentCustomFields(
  sha256: string,
  request: IngestRequest,
  deps: RouterDeps,
  fields: CustomFields,
): Promise<IngestResponse> {
  if (request.method === 'GET') {
    if (!(await deps.storage.has(sha256))) return fail('not_found');
    const response: DocumentCustomFieldsResponse = { values: await fields.valuesOf(sha256) };
    return { status: 200, json: response };
  }
  if (request.method !== 'PUT') return fail('bad_request', `${request.method} not allowed here`);
  const body = parseJson<unknown>(request.body);
  if (!isCustomFieldValuesBody(body)) {
    return fail('bad_request', 'body must be {"values": [{"field": <id>, "value": ...}, ...]}');
  }
  const result = await fields.setValues(sha256, body.values, deps.now());
  if (!result.ok) return refusal(result);
  const response: DocumentCustomFieldsResponse = { values: result.value };
  return { status: 200, json: response };
}

function refusal(reason: CustomFieldRefusal): IngestResponse {
  switch (reason.kind) {
    case 'not_found':
      return fail('not_found');
    case 'conflict':
      return fail('conflict', reason.message);
    case 'invalid':
      return fail('bad_request', reason.message);
  }
}

/**
 * Correspondents, document types and tags. Anyone may read them; changing one
 * rewrites every document carrying it, so that is the admin's.
 */
async function labelRoutes(
  request: IngestRequest,
  labels: Labels,
  principal: Principal,
): Promise<IngestResponse> {
  const { method } = request;
  const [segment, idPart, action, ...extra] = request.path
    .slice(`/${PROTOCOL_VERSION}/labels/`.length)
    .split('/');
  const kind = labelKindOf(segment ?? '');
  if (kind === null || extra.length > 0) return fail('not_found');

  if (idPart === undefined) {
    if (method === 'GET') {
      const response: LabelsResponse = { labels: await labels.list(kind) };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token adds labels');
    const body = parseJson<unknown>(request.body);
    const ruleProblem = ruleProblemOf(body);
    if (ruleProblem !== null) return fail('bad_request', ruleProblem);
    if (!isLabelBody(body)) {
      return fail(
        'bad_request',
        'body must be {"name": "..."}, with "colour": "#rrggbb" for a tag',
      );
    }
    const created = await labels.create(kind, body);
    return created.ok ? { status: 201, json: created.value } : labelRefusal(created);
  }

  if (!/^[1-9][0-9]{0,15}$/.test(idPart)) {
    return fail('malformed_id', 'label ids are positive integers');
  }
  const id = Number(idPart);

  if (action !== undefined) {
    if (action !== 'merge') return fail('not_found');
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token merges labels');
    const body = parseJson<unknown>(request.body);
    if (!isLabelMergeBody(body)) return fail('bad_request', 'body must be {"into": <id>}');
    const merged = await labels.merge(kind, id, body.into);
    return merged.ok ? { status: 200, json: merged.value } : labelRefusal(merged);
  }

  if (method === 'GET') {
    const label = await labels.get(kind, id);
    return label === null ? fail('not_found') : { status: 200, json: label };
  }
  if (method !== 'PATCH' && method !== 'DELETE') {
    return fail('bad_request', `${method} not allowed here`);
  }
  if (principal.kind !== 'admin') return fail('forbidden', 'only the admin token changes labels');
  if (method === 'DELETE')
    return (await labels.remove(kind, id)) ? { status: 204 } : fail('not_found');
  const patch = parseJson<unknown>(request.body);
  const ruleProblem = ruleProblemOf(patch);
  if (ruleProblem !== null) return fail('bad_request', ruleProblem);
  if (!isLabelPatch(patch)) {
    return fail(
      'bad_request',
      'body may hold only "name", "matching" and, for a tag, "colour" and "inbox"',
    );
  }
  const updated = await labels.update(kind, id, patch);
  return updated.ok ? { status: 200, json: updated.value } : labelRefusal(updated);
}

/** What is wrong with the rule a label body carries, if it carries one. */
function ruleProblemOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const rule = (body as Record<string, unknown>)['matching'];
  return rule === undefined ? null : matchingRuleProblem(rule);
}

function labelRefusal(reason: LabelRefusal): IngestResponse {
  switch (reason.kind) {
    case 'not_found':
      return fail('not_found');
    case 'conflict':
      return fail('conflict', reason.message);
    case 'invalid':
      return fail('bad_request', reason.message);
  }
}

/** Listing, restoring and emptying the trash. Emptying is the admin's alone. */
async function trash(
  request: IngestRequest,
  deps: RouterDeps,
  principal: Principal,
): Promise<IngestResponse> {
  const { method, path } = request;
  const days = deps.trashDays ?? DEFAULT_TRASH_DAYS;
  if (path === paths.trash()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const keepMs = days * 86_400_000;
    const response: TrashResponse = {
      documents: (await deps.storage.trashed()).map((entry) => ({
        ...entry,
        purgeAt: entry.trashedAt + keepMs,
      })),
      purgeAfterDays: days,
    };
    return { status: 200, json: response };
  }
  const restoring = path === paths.trashRestore();
  if (!restoring && path !== paths.trashEmpty()) return fail('not_found');
  if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
  if (!restoring && principal.kind !== 'admin') {
    return fail('forbidden', 'only the admin token deletes documents for good');
  }
  const body = parseJson<unknown>(request.body);
  if (!isTrashActionBody(body)) {
    return fail('bad_request', 'body must be {"documents": ["<sha256>", ...]}');
  }
  let count: number;
  if (restoring) {
    if (body.documents === undefined) {
      return fail('bad_request', 'say which documents to restore');
    }
    count = await deps.storage.restore(body.documents);
  } else {
    const chosen = body.documents ?? (await deps.storage.trashed()).map((entry) => entry.sha256);
    count = 0;
    for (const sha256 of chosen) if (await deps.storage.purge(sha256)) count++;
  }
  const response: TrashActionResponse = { count };
  return { status: 200, json: response };
}

/** `…/notes` lists and adds; `…/notes/{id}` deletes one. */
async function notes(
  sha256: string,
  noteId: string | undefined,
  request: IngestRequest,
  deps: RouterDeps,
  principal: Principal,
): Promise<IngestResponse> {
  const { method } = request;
  if (noteId !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(noteId)) {
      return fail('malformed_id', 'note ids are positive integers');
    }
    if (method !== 'DELETE') return fail('bad_request', `${method} not allowed here`);
    return (await deps.storage.deleteNote(sha256, Number(noteId)))
      ? { status: 204 }
      : fail('not_found');
  }
  if (method === 'GET') {
    if (!(await deps.storage.has(sha256))) return fail('not_found');
    const response: NotesResponse = { notes: await deps.storage.notes(sha256) };
    return { status: 200, json: response };
  }
  if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
  const body = parseJson<unknown>(request.body);
  if (!isNoteBody(body)) {
    return fail(
      'bad_request',
      `body must be {"text": "..."}, not blank, at most ${String(MAX_NOTE_LENGTH)} characters`,
    );
  }
  const note = await deps.storage.addNote(
    sha256,
    body.text.trim(),
    principal.kind === 'device' ? principal.id : null,
    deps.now(),
  );
  return note === null ? fail('not_found') : { status: 201, json: note };
}

async function readRecord(id: string, deps: RouterDeps): Promise<DocumentRecord | null> {
  return deps.storage.record(id);
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
