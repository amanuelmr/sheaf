import { timingSafeEqual } from 'node:crypto';
import {
  DOCUMENT_CONTENT_TYPE,
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  PROTOCOL_VERSION,
  bearerToken,
  isSha256,
  paths,
  type DocumentPatch,
  type ErrorCode,
  type HealthResponse,
  type ListResponse,
  type SuggestionsResponse,
} from '@sheaf/protocol';
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
