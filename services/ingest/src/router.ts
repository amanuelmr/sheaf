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
  documentPatchProblem,
  filterFromParams,
  isCustomFieldBody,
  isCustomFieldPatch,
  isCustomFieldValuesBody,
  isDocumentTextBody,
  isApplyRulesBody,
  isDocumentPermissions,
  settingsPatchProblem,
  isMergeBody,
  isPagesBody,
  isSplitBody,
  isSessionBody,
  isUserBody,
  isUserPatch,
  workflowProblem,
  isShareLinkBody,
  isBulkEditBody,
  isSavedViewBody,
  isSavedViewPatch,
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
  type SsoResponse,
  type UserDirectoryResponse,
  type SettingsPatch,
  type SettingsResponse,
  type NewDocumentsResponse,
  type PageCountResponse,
  type VersionsResponse,
  type AuditResponse,
  type Me,
  type SessionResponse,
  type UsersResponse,
  type WorkflowBody,
  type WorkflowsResponse,
  type ShareLinksResponse,
  type NextAsnResponse,
  type BulkEditResponse,
  type SavedViewsResponse,
  type ApplyRulesResponse,
  type NotesResponse,
  type PairRequest,
  type PairResponse,
  type PairingCodeResponse,
  type ReconciliationProbe,
  type SearchResponse,
  type SimilarResponse,
  type StampBody,
  stampProblem,
  type SuggestionsResponse,
  type TrashActionResponse,
  type TrashResponse,
} from '@sheaf/protocol';
import type { CustomFieldRefusal, CustomFields } from './custom-fields.ts';
import type { LabelRefusal, Labels } from './labels.ts';
import type { Rules } from './rules.ts';
import type { BulkEditor } from './bulk.ts';
import type { ShareLinks } from './share-links.ts';
import type { Workflows } from './workflows.ts';
import type { Users } from './users.ts';
import type { Sso } from './sso.ts';
import type { Actor, AuditLog } from './audit.ts';
import type { DocumentEdits, EditRefusal } from './document-edits.ts';
import type { Settings } from './settings.ts';
import type { SavedViews, ViewRefusal } from './views.ts';
import type { ArchiveSource } from './paperless-browse.ts';
import type { Devices } from './devices.ts';
import type { ServerMetrics } from './observability.ts';
import { toMatch } from './search-query.ts';
import { exportCsv } from './csv-export.ts';
import { searchableBytes } from './searchable.ts';
import type { NearDuplicates } from './near-duplicates.ts';
import type { Storage } from './storage.ts';
import { AsnTaken, PRIMARY_CONNECTOR, sha256Hex } from './storage.ts';
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
  /** Filters kept under a name. Absent, those routes answer 404. */
  readonly views?: SavedViews;
  /** One change to many documents. Absent, the route answers 404. */
  readonly bulk?: BulkEditor;
  /** Links that open a document without a token. Absent, those routes answer 404. */
  readonly shareLinks?: ShareLinks;
  /** "When this, do that". Absent, those routes answer 404 and nothing runs. */
  readonly workflows?: Workflows;
  /** People who sign in with a password. Absent, only tokens are accepted. */
  readonly users?: Users;
  /** Where changes are written down. Absent, nothing is. */
  readonly audit?: AuditLog;
  /** Page edits, splits, merges and versions. Absent, those routes answer 404. */
  readonly edits?: DocumentEdits;
  /** Settings an admin can change while the server runs. */
  readonly settings?: Settings;
  /** Single sign-on through an OpenID Connect provider. Absent, it is off. */
  readonly sso?: Sso;
  /** Re-scans of the same paper, found by their words. Absent, the route answers 404. */
  readonly nearDuplicates?: NearDuplicates;
}

/** Prometheus's conventional path, outside the versioned protocol. */
export const METRICS_PATH = '/metrics';

/** Who a request is from: the operator's admin token, or one paired phone. */
type Principal =
  | { readonly kind: 'admin' }
  | { readonly kind: 'device'; readonly id: string }
  | {
      readonly kind: 'user';
      readonly id: number;
      readonly username: string;
      readonly role: 'admin' | 'editor' | 'viewer';
    };

/**
 * Whose view of the documents to keep to, or null for all of them: a person who
 * is not an admin sees what is shared, theirs, or shared with them. Phones, the
 * admin token and admins see everything.
 */
function viewerOf(principal: Principal): number | null {
  return principal.kind === 'user' && principal.role !== 'admin' ? principal.id : null;
}

/** The admin token, or a person signed in with the admin role. */
function isAdmin(principal: Principal): boolean {
  return principal.kind === 'admin' || (principal.kind === 'user' && principal.role === 'admin');
}

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
  const user = await deps.users?.authenticate(provided, deps.now());
  if (user !== undefined && user !== null) return { kind: 'user', ...user };
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

  // A share link: whoever holds it may read that one document, and nothing else.
  if (path.startsWith('/share/') && deps.shareLinks !== undefined) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const sha256 = await deps.shareLinks.resolve(path.slice('/share/'.length), deps.now());
    const bytes = sha256 === null ? null : deps.storage.bytes(sha256);
    if (bytes === null) return fail('not_found', 'this link does not work, or no longer does');
    return {
      status: 200,
      headers: {
        'content-type': DOCUMENT_CONTENT_TYPE,
        'content-disposition': 'inline',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      },
      bytes,
    };
  }

  // Single sign-on: before a token, by definition. The callback answers with a
  // redirect to the web app either way, so a person never lands on raw JSON.
  if (path === paths.sso()) {
    const response: SsoResponse = {
      enabled: deps.sso !== undefined,
      name: deps.sso?.name ?? null,
    };
    return { status: 200, json: response };
  }
  if (path === paths.ssoStart() && deps.sso !== undefined) {
    try {
      return { status: 302, headers: { location: await deps.sso.start(deps.now()) } };
    } catch {
      return fail('server_error', 'the identity provider could not be reached');
    }
  }
  if (path === paths.ssoCallback() && deps.sso !== undefined) {
    const params = new URLSearchParams(request.query);
    const code = params.get('code');
    const state = params.get('state');
    if (code === null || state === null) {
      return fail(
        'bad_request',
        params.get('error_description') ?? params.get('error') ?? 'no code',
      );
    }
    try {
      const signed = await deps.sso.finish(code, state, deps.now());
      if (!signed.ok) return fail('unauthenticated', signed.message);
      return { status: 302, headers: { location: signed.redirect, 'cache-control': 'no-store' } };
    } catch {
      return fail('server_error', 'the identity provider could not be reached');
    }
  }

  // Signing in: the person has a password, not yet a token.
  if (path === paths.sessions() && deps.users !== undefined) {
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isSessionBody(body)) return fail('bad_request', 'body must be {"username", "password"}');
    const signed = await deps.users.signIn(body.username, body.password, deps.now());
    if (!signed.ok) {
      return signed.reason === 'locked'
        ? fail('rate_limited', 'too many wrong passwords; try again in fifteen minutes')
        : fail('unauthenticated', 'wrong username or password');
    }
    const response: SessionResponse = {
      token: signed.token,
      expiresAt: signed.expiresAt,
      user: signed.user,
    };
    return { status: 201, json: response };
  }

  const principal = await authenticate(request, deps);
  if (principal === 'revoked') {
    return fail('device_revoked', 'this device was removed; pair it again to keep syncing');
  }
  if (principal === null) return fail('unauthenticated');

  const response = await authenticated(request, deps, principal);
  // A change that went through is written down, with who made it.
  if (deps.audit !== undefined && method !== 'GET' && response.status < 400) {
    await deps.audit.record(actorOf(principal), method, path, response.status, deps.now());
  }
  return response;
}

function actorOf(principal: Principal): Actor {
  switch (principal.kind) {
    case 'admin':
      return { kind: 'admin' };
    case 'device':
      return { kind: 'device', id: principal.id };
    case 'user':
      return { kind: 'user', id: principal.id, name: principal.username };
  }
}

/** Every route that needs a token, once it is known whose token it is. */
async function authenticated(
  request: IngestRequest,
  deps: RouterDeps,
  principal: Principal,
): Promise<IngestResponse> {
  const { method, path } = request;

  if (path === paths.currentSession()) {
    if (method !== 'DELETE') return fail('bad_request', `${method} not allowed here`);
    if (principal.kind === 'user' && deps.users !== undefined) {
      await deps.users.signOut(bearerToken(request.headers['authorization']) ?? '');
    }
    return { status: 204 };
  }

  // A viewer reads; every change is refused here, once, rather than route by route.
  if (principal.kind === 'user' && principal.role === 'viewer' && method !== 'GET') {
    return fail('forbidden', 'a viewer can only read');
  }

  if (path === paths.me()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const me: Me =
      principal.kind === 'admin'
        ? { kind: 'admin-token', id: null, role: 'admin', name: null }
        : principal.kind === 'device'
          ? { kind: 'device', id: null, role: 'editor', name: null }
          : { kind: 'user', id: principal.id, role: principal.role, name: principal.username };
    return { status: 200, json: me };
  }

  if (path === paths.settings()) {
    if (deps.settings === undefined) return fail('not_found');
    if (!isAdmin(principal)) return fail('forbidden', 'only an admin changes settings');
    if (method === 'PATCH') {
      const patch = parseJson<unknown>(request.body);
      const problem = settingsPatchProblem(patch);
      if (problem !== null) return fail('bad_request', problem);
      await deps.settings.update(patch as SettingsPatch, deps.now());
    } else if (method !== 'GET') {
      return fail('bad_request', `${method} not allowed here`);
    }
    const response: SettingsResponse = {
      settings: deps.settings.current(),
      sources: deps.settings.sources(),
    };
    return { status: 200, json: response };
  }

  if (path === paths.audit()) {
    if (deps.audit === undefined) return fail('not_found');
    if (!isAdmin(principal)) return fail('forbidden', 'only an admin reads the audit log');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const params = new URLSearchParams(request.query);
    const limit = whole(params.get('limit'), 100);
    const before = params.get('before');
    if (limit === null || limit < 1 || limit > 500)
      return fail('bad_request', 'limit must be 1 to 500');
    if (before !== null && !/^[1-9][0-9]{0,15}$/.test(before)) {
      return fail('bad_request', 'before must be an entry id');
    }
    const response: AuditResponse = {
      entries: await deps.audit.list({
        limit,
        ...(before === null ? {} : { before: Number(before) }),
      }),
    };
    return { status: 200, json: response };
  }

  if (path === paths.userDirectory()) {
    if (deps.users === undefined) return fail('not_found');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const response: UserDirectoryResponse = { users: await deps.users.directory() };
    return { status: 200, json: response };
  }

  if (path === paths.users() || path.startsWith(`${paths.users()}/`)) {
    if (deps.users === undefined) return fail('not_found');
    if (!isAdmin(principal)) return fail('forbidden', 'only an admin manages users');
    return userRoutes(request, deps, deps.users, principal);
  }

  if (path === METRICS_PATH && deps.metrics !== undefined) {
    // Admin only: counts of documents and phones are not a paired phone's business.
    if (!isAdmin(principal)) return fail('forbidden', 'metrics need the admin token');
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
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token manages devices');
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
    const response: InboxResponse = {
      documents: await deps.storage.inbox(100, viewerOf(principal)),
    };
    return { status: 200, json: response };
  }

  if (path === paths.accuracy()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    return { status: 200, json: await deps.storage.accuracy() };
  }

  if (path === paths.searchExport()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const read = filterFromParams(new URLSearchParams(request.query));
    if (!read.ok) return fail('bad_request', read.problem);
    const match = read.filter.text === undefined ? null : toMatch(read.filter.text);
    const viewer = viewerOf(principal);
    const { csv, truncated } = await exportCsv(
      (limit, offset) =>
        read.filter.text !== undefined && match === null
          ? Promise.resolve({ hits: [], hasMore: false, total: 0 })
          : deps.storage.find(match, read.filter, limit, offset, viewer),
      deps.customFields,
    );
    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="documents.csv"',
        'x-sheaf-truncated': String(truncated),
      },
      bytes: new TextEncoder().encode(csv),
    };
  }

  if (path === paths.search()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    return search(request.query, deps, viewerOf(principal));
  }

  if (path === paths.customFields() || path.startsWith(`${paths.customFields()}/`)) {
    if (deps.customFields === undefined) return fail('not_found');
    return customFieldDefinitions(request, deps, deps.customFields, principal);
  }

  if (path === paths.views() || path.startsWith(`${paths.views()}/`)) {
    if (deps.views === undefined) return fail('not_found');
    return savedViews(request, deps, deps.views);
  }

  if (path === paths.labelsApply()) {
    if (deps.rules === undefined) return fail('not_found');
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token applies rules');
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

  if (path.startsWith(`/${PROTOCOL_VERSION}/share-links/`)) {
    if (deps.shareLinks === undefined) return fail('not_found');
    if (method !== 'DELETE') return fail('bad_request', `${method} not allowed here`);
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token revokes links');
    const idPart = path.slice(`/${PROTOCOL_VERSION}/share-links/`.length);
    if (!/^[1-9][0-9]{0,15}$/.test(idPart))
      return fail('malformed_id', 'link ids are positive integers');
    return (await deps.shareLinks.revoke(Number(idPart))) ? { status: 204 } : fail('not_found');
  }

  if (path === paths.workflows() || path.startsWith(`${paths.workflows()}/`)) {
    if (deps.workflows === undefined) return fail('not_found');
    return workflowRoutes(request, deps, deps.workflows, principal);
  }

  if (path === paths.nextAsn()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const response: NextAsnResponse = { asn: await deps.storage.nextAsn() };
    return { status: 200, json: response };
  }

  if (path === paths.mergeDocuments()) {
    if (deps.edits === undefined) return fail('not_found');
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isMergeBody(body)) {
      return fail(
        'bad_request',
        'body must be {"documents": [two or more sha256s], "keepOriginals"?: true}',
      );
    }
    const refused = await changeRefused(deps, principal, body.documents);
    if (refused !== null) return refused;
    const merged = await deps.edits.merge(body.documents, body.keepOriginals === true, deps.now());
    if (!merged.ok) return editRefusal(merged);
    return { status: 201, json: await deps.storage.record(merged.sha256) };
  }

  if (path === paths.bulkEdit()) {
    if (deps.bulk === undefined) return fail('not_found');
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isBulkEditBody(body)) {
      return fail(
        'bad_request',
        'body must be {"documents": [sha256, ...], "action": {"kind": ...}}; see BulkAction',
      );
    }
    const refused = await changeRefused(deps, principal, body.documents);
    if (refused !== null) return refused;
    const outcome = await deps.bulk.edit(body.documents, body.action, deps.now());
    if (!outcome.ok) return fail('bad_request', outcome.message);
    const response: BulkEditResponse = { changed: outcome.changed };
    return { status: 200, json: response };
  }

  if (path === paths.documents()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const list: ListResponse = { documents: await deps.storage.list(200, viewerOf(principal)) };
    return { status: 200, json: list };
  }

  if (path === paths.archive() || path.startsWith(`${paths.archive()}/`)) {
    // The archive is browsed whole; a person who sees only some documents searches.
    if (viewerOf(principal) !== null) {
      return fail('forbidden', 'search to find your documents; browsing the archive is for admins');
    }
    return archive(path, request, deps);
  }

  const prefix = `${paths.documents()}/`;
  if (!path.startsWith(prefix)) return fail('not_found');
  const rest = path.slice(prefix.length);

  // A document a person may not see is not there, as far as they can tell; one they
  // may only see, they cannot change.
  const viewer = viewerOf(principal);
  const target = rest.split('/')[0] ?? '';
  if (viewer !== null && isSha256(target)) {
    const access = await deps.storage.access(target, viewer);
    if (access === 'none') return fail('not_found');
    if (access === 'view' && method !== 'GET') {
      return fail('forbidden', 'this document was shared with you to read, not to change');
    }
  }

  if (rest === `${target}/permissions` && isSha256(target)) {
    return documentPermissions(request, deps, principal, target);
  }

  const [docId, area, versionId, versionAction, ...extra] = rest.split('/');
  if (
    deps.edits !== undefined &&
    docId !== undefined &&
    isSha256(docId) &&
    (area === 'pages' || area === 'split' || area === 'versions' || area === 'stamp') &&
    extra.length === 0
  ) {
    return editRoutes(request, deps, deps.edits, docId, area, versionId, versionAction);
  }

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

  const shareSuffix = '/share-links';
  if (rest.endsWith(shareSuffix)) {
    const id = rest.slice(0, -shareSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (deps.shareLinks === undefined) return fail('not_found');
    if (method === 'GET') {
      if (!(await deps.storage.has(id))) return fail('not_found');
      const response: ShareLinksResponse = { links: await deps.shareLinks.list(id) };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token shares documents');
    const body = request.body.length === 0 ? {} : parseJson<unknown>(request.body);
    if (!isShareLinkBody(body)) {
      return fail('bad_request', 'body may hold "expiresInDays": a whole number of days, or null');
    }
    const link = await deps.shareLinks.create(id, body.expiresInDays ?? null, deps.now());
    return link === null ? fail('not_found') : { status: 201, json: link };
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

  const searchableSuffix = '/searchable.pdf';
  if (rest.endsWith(searchableSuffix)) {
    const id = rest.slice(0, -searchableSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const bytes = await searchableBytes(deps.storage, id);
    if (bytes === null) return fail('not_found');
    return { status: 200, headers: { 'content-type': DOCUMENT_CONTENT_TYPE }, bytes };
  }

  const similarSuffix = '/similar';
  if (rest.endsWith(similarSuffix)) {
    const id = rest.slice(0, -similarSuffix.length);
    if (!isSha256(id)) return fail('malformed_id', 'document ids are lowercase hex SHA-256');
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    if (deps.nearDuplicates === undefined || !(await deps.storage.has(id))) {
      return fail('not_found');
    }
    const response: SimilarResponse = {
      documents: await deps.nearDuplicates.similarTo(id, viewer),
    };
    return { status: 200, json: response };
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
      const problem = documentPatchProblem(patch);
      if (problem !== null) return fail('bad_request', problem);
      try {
        const record = await deps.storage.patch(id, patch!, deps.now());
        if (record === null) return fail('not_found');
        if (deps.workflows === undefined) return { status: 200, json: record };
        // A person edited it: workflows for updated documents run, and the answer
        // shows what they did too.
        await deps.workflows.run('updated', id, deps.now());
        return { status: 200, json: await deps.storage.record(id) };
      } catch (error) {
        if (error instanceof AsnTaken) return fail('conflict', error.message);
        throw error;
      }
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
    // What a person uploads is theirs; what a phone or the admin token sends is shared.
    principal.kind === 'user' ? principal.id : null,
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
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token defines fields');
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
  if (!isAdmin(principal)) return fail('forbidden', 'only the admin token changes fields');
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
  // A person filling in a document fills in what every document must have.
  const missing = await fields.missingRequired(body.values);
  if (missing.length > 0) {
    return fail(
      'bad_request',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required: give ${missing.length === 1 ? 'it' : 'them'} a value`,
    );
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
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token adds labels');
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
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token merges labels');
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
  if (!isAdmin(principal)) return fail('forbidden', 'only the admin token changes labels');
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

/** Users: the admin's alone. An admin cannot lock themselves out by demoting or removing themselves. */
async function userRoutes(
  request: IngestRequest,
  deps: RouterDeps,
  users: Users,
  principal: Principal,
): Promise<IngestResponse> {
  const { method, path } = request;
  if (path === paths.users()) {
    if (method === 'GET') {
      const response: UsersResponse = { users: await users.list() };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isUserBody(body)) {
      return fail(
        'bad_request',
        'body must be {"username": lower case letters, digits, . _ -, "password": at least 10 characters, "role": admin, editor or viewer}',
      );
    }
    const created = await users.create(body, deps.now());
    return created === 'taken'
      ? fail('conflict', `a user named "${body.username}" already exists`)
      : { status: 201, json: created };
  }
  const idPart = path.slice(paths.users().length + 1);
  if (!/^[1-9][0-9]{0,15}$/.test(idPart))
    return fail('malformed_id', 'user ids are positive integers');
  const id = Number(idPart);
  const self = principal.kind === 'user' && principal.id === id;
  if (method === 'DELETE') {
    if (self) return fail('bad_request', 'you cannot remove yourself');
    return (await users.remove(id)) ? { status: 204 } : fail('not_found');
  }
  if (method !== 'PATCH') return fail('bad_request', `${method} not allowed here`);
  const patch = parseJson<unknown>(request.body);
  if (!isUserPatch(patch)) {
    return fail(
      'bad_request',
      'body may hold "password" (at least 10 characters), "role" and "disabled"',
    );
  }
  if (self && ((patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true)) {
    return fail('bad_request', 'you cannot take away your own admin role or disable yourself');
  }
  const updated = await users.update(id, patch, deps.now());
  return updated === null ? fail('not_found') : { status: 200, json: updated };
}

/**
 * Refuses a change to many documents unless the person may change every one: 404
 * names one they may not see, 403 one they may only read.
 */
async function changeRefused(
  deps: RouterDeps,
  principal: Principal,
  documents: readonly string[],
): Promise<IngestResponse | null> {
  const viewer = viewerOf(principal);
  if (viewer === null) return null;
  for (const sha256 of documents) {
    const access = await deps.storage.access(sha256, viewer);
    if (access === 'none') return fail('not_found', `no document ${sha256.slice(0, 12)}…`);
    if (access === 'view') {
      return fail('forbidden', `document ${sha256.slice(0, 12)}… was shared with you to read`);
    }
  }
  return null;
}

/** Who a document belongs to and whom it is shared with; its owner or an admin decides. */
async function documentPermissions(
  request: IngestRequest,
  deps: RouterDeps,
  principal: Principal,
  sha256: string,
): Promise<IngestResponse> {
  const current = await deps.storage.permissions(sha256);
  if (current === null) return fail('not_found');
  if (request.method === 'GET') return { status: 200, json: current };
  if (request.method !== 'PUT') return fail('bad_request', `${request.method} not allowed here`);
  const own = principal.kind === 'user' && current.owner === principal.id;
  if (!isAdmin(principal) && !own) {
    return fail('forbidden', 'only its owner or an admin decides who sees a document');
  }
  const body = parseJson<unknown>(request.body);
  if (!isDocumentPermissions(body)) {
    return fail(
      'bad_request',
      'body must be {"owner": <user id> or null, "grants": [{"user", "level": view or change}]}',
    );
  }
  const known = new Set(((await deps.users?.directory()) ?? []).map((user) => user.id));
  const unknown = [body.owner, ...body.grants.map((grant) => grant.user)].find(
    (id) => id !== null && !known.has(id),
  );
  if (unknown !== undefined) return fail('bad_request', `there is no user ${String(unknown)}`);
  await deps.storage.setPermissions(sha256, body);
  return { status: 200, json: await deps.storage.permissions(sha256) };
}

/** Workflows: anyone may read them; only the admin token changes them. */
async function workflowRoutes(
  request: IngestRequest,
  deps: RouterDeps,
  workflows: Workflows,
  principal: Principal,
): Promise<IngestResponse> {
  const { method, path } = request;
  const body = (): WorkflowBody | IngestResponse => {
    const parsed = parseJson<unknown>(request.body);
    const problem = workflowProblem(parsed);
    return problem === null ? (parsed as WorkflowBody) : fail('bad_request', problem);
  };
  const isBody = (value: WorkflowBody | IngestResponse): value is WorkflowBody =>
    'trigger' in value;

  if (path === paths.workflows()) {
    if (method === 'GET') {
      const response: WorkflowsResponse = { workflows: await workflows.list() };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    if (!isAdmin(principal)) return fail('forbidden', 'only the admin token changes workflows');
    const parsed = body();
    if (!isBody(parsed)) return parsed;
    return { status: 201, json: await workflows.create(parsed, deps.now()) };
  }
  const idPart = path.slice(paths.workflows().length + 1);
  if (!/^[1-9][0-9]{0,15}$/.test(idPart))
    return fail('malformed_id', 'workflow ids are positive integers');
  const id = Number(idPart);
  if (method === 'GET') {
    const workflow = await workflows.get(id);
    return workflow === null ? fail('not_found') : { status: 200, json: workflow };
  }
  if (method !== 'PUT' && method !== 'DELETE')
    return fail('bad_request', `${method} not allowed here`);
  if (!isAdmin(principal)) return fail('forbidden', 'only the admin token changes workflows');
  if (method === 'DELETE')
    return (await workflows.remove(id)) ? { status: 204 } : fail('not_found');
  const parsed = body();
  if (!isBody(parsed)) return parsed;
  const replaced = await workflows.replace(id, parsed);
  return replaced === null ? fail('not_found') : { status: 200, json: replaced };
}

/** Saved views: anyone with a token keeps their own shortcuts here. */
async function savedViews(
  request: IngestRequest,
  deps: RouterDeps,
  views: SavedViews,
): Promise<IngestResponse> {
  const { method, path } = request;
  if (path === paths.views()) {
    if (method === 'GET') {
      const response: SavedViewsResponse = { views: await views.list() };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isSavedViewBody(body)) {
      return fail(
        'bad_request',
        'body must be {"name": "...", "filter": {...}, "onDashboard"?: true}',
      );
    }
    const created = await views.create(body, deps.now());
    return created.ok ? { status: 201, json: created.value } : viewRefusal(created);
  }
  const idPart = path.slice(paths.views().length + 1);
  if (!/^[1-9][0-9]{0,15}$/.test(idPart))
    return fail('malformed_id', 'view ids are positive integers');
  const id = Number(idPart);
  switch (method) {
    case 'GET': {
      const view = await views.get(id);
      return view === null ? fail('not_found') : { status: 200, json: view };
    }
    case 'DELETE':
      return (await views.remove(id)) ? { status: 204 } : fail('not_found');
    case 'PATCH': {
      const patch = parseJson<unknown>(request.body);
      if (!isSavedViewPatch(patch)) {
        return fail('bad_request', 'body may hold "name", "filter", "onDashboard" and "position"');
      }
      const updated = await views.update(id, patch);
      return updated.ok ? { status: 200, json: updated.value } : viewRefusal(updated);
    }
    default:
      return fail('bad_request', `${method} not allowed here`);
  }
}

function viewRefusal(reason: ViewRefusal): IngestResponse {
  return reason.kind === 'not_found' ? fail('not_found') : fail('conflict', reason.message);
}

/** What is wrong with the rule a label body carries, if it carries one. */
function ruleProblemOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const rule = (body as Record<string, unknown>)['matching'];
  return rule === undefined ? null : matchingRuleProblem(rule);
}

/** Page edits, splits and versions of one document. */
async function editRoutes(
  request: IngestRequest,
  deps: RouterDeps,
  edits: DocumentEdits,
  sha256: string,
  area: 'pages' | 'split' | 'versions' | 'stamp',
  version: string | undefined,
  action: string | undefined,
): Promise<IngestResponse> {
  const { method } = request;
  if (area === 'pages' && version === undefined) {
    if (method === 'GET') {
      const pages = await edits.pages(sha256);
      if (pages === null) return fail('not_found');
      const response: PageCountResponse = { pages };
      return { status: 200, json: response };
    }
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isPagesBody(body)) {
      return fail('bad_request', 'body must be {"pages": [{"page": 1, "rotate"?: 90}, ...]}');
    }
    const edited = await edits.editPages(sha256, body.pages, deps.now());
    if (!edited.ok) return editRefusal(edited);
    return { status: 200, json: await deps.storage.record(edited.sha256) };
  }
  if (area === 'stamp' && version === undefined) {
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    const problem = stampProblem(body);
    if (problem !== null) return fail('bad_request', problem);
    const stamped = await edits.stamp(sha256, body as StampBody, deps.now());
    if (!stamped.ok) return editRefusal(stamped);
    return { status: 200, json: await deps.storage.record(stamped.sha256) };
  }
  if (area === 'split' && version === undefined) {
    if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
    const body = parseJson<unknown>(request.body);
    if (!isSplitBody(body)) {
      return fail('bad_request', 'body must be {"parts": [[1, 2], [3]], "keepOriginal"?: true}');
    }
    const split = await edits.split(sha256, body.parts, body.keepOriginal === true, deps.now());
    if (!split.ok) return editRefusal(split);
    const response: NewDocumentsResponse = { documents: split.documents };
    return { status: 201, json: response };
  }
  if (area === 'versions') {
    if (version === undefined) {
      if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
      if (!(await deps.storage.has(sha256))) return fail('not_found');
      const response: VersionsResponse = { versions: await deps.storage.versions(sha256) };
      return { status: 200, json: response };
    }
    if (!isSha256(version)) return fail('malformed_id', 'versions are named by their sha256');
    if (action === undefined) {
      if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
      const bytes = await deps.storage.versionBytes(sha256, version);
      return bytes === null
        ? fail('not_found')
        : { status: 200, headers: { 'content-type': DOCUMENT_CONTENT_TYPE }, bytes };
    }
    if (action === 'restore') {
      if (method !== 'POST') return fail('bad_request', `${method} not allowed here`);
      const restored = await deps.storage.restoreVersion(sha256, version, deps.now());
      if (restored.kind === 'not_found') return fail('not_found');
      if (restored.kind === 'exists') {
        return fail('conflict', 'that file is a document of its own now');
      }
      return { status: 200, json: await deps.storage.record(restored.sha256) };
    }
  }
  return fail('not_found');
}

function editRefusal(refusal: EditRefusal): IngestResponse {
  switch (refusal.kind) {
    case 'not_found':
      return fail('not_found');
    case 'invalid':
      return fail('bad_request', refusal.message);
    case 'conflict':
      return fail('conflict', refusal.message);
  }
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
  const days = deps.settings?.current().trashDays ?? deps.trashDays ?? DEFAULT_TRASH_DAYS;
  if (path === paths.trash()) {
    if (method !== 'GET') return fail('bad_request', `${method} not allowed here`);
    const keepMs = days * 86_400_000;
    const response: TrashResponse = {
      documents: (await deps.storage.trashed(viewerOf(principal))).map((entry) => ({
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
  if (!restoring && !isAdmin(principal)) {
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
    const refused = await changeRefused(deps, principal, body.documents);
    if (refused !== null) return refused;
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

async function search(
  query: string,
  deps: RouterDeps,
  viewer: number | null,
): Promise<IngestResponse> {
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

  const read = filterFromParams(params);
  if (!read.ok) return fail('bad_request', read.problem);
  const { filter } = read;

  // Anything typed is searchable; text with no words in it simply matches nothing.
  // With nothing typed, the filter alone decides.
  const match = filter.text === undefined ? null : toMatch(filter.text);
  const response: SearchResponse =
    filter.text !== undefined && match === null
      ? { hits: [], hasMore: false, total: 0 }
      : await deps.storage.find(match, filter, limit, offset, viewer);
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
