import { classifyResponse, classifyThrown } from './errors';
import { joinUrl, redact, type PaperlessConfig } from './config';
import { err, ok, type ApiResult } from './result';
import type { FormDataLike, HttpRequest, UploadFile } from './http';
import { captureFilename, matchesCaptureId } from './reconcile';
import type {
  DocumentPatch,
  DocumentSummary,
  NamedResource,
  PaperlessTask,
  RawSuggestions,
  ReconcileProbe,
  ServerInfo,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin client over the Paperless-ngx REST API.
 *
 * Two rules it exists to enforce:
 *
 *  - The token lives in a private field and is scrubbed from anything that could
 *    escape as text. It is never interpolated into a URL or an error message.
 *  - Nothing here interprets outcomes. `postDocument` returns a task id and stops;
 *    deciding what that means is `interpretTask`'s job, and deciding what to do
 *    about it is the core state machine's.
 */
export class PaperlessClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #config: PaperlessConfig;

  constructor(config: PaperlessConfig) {
    this.#config = config;
    this.#token = config.token;
    this.#baseUrl = config.baseUrl;
  }

  /** Never let the token ride along in a stringified client. */
  toJSON(): Record<string, string> {
    return { baseUrl: this.#baseUrl, token: '[redacted]' };
  }

  /**
   * Is this a Paperless server, and does our token work?
   *
   * Deliberately hits an authenticated endpoint: an unauthenticated 200 would tell
   * us the host is reachable while leaving the token untested until the first
   * upload, which is the worst possible moment to find out.
   */
  async testConnection(): Promise<ApiResult<ServerInfo>> {
    const result = await this.#request('api/documents/?page_size=1', { method: 'GET' });
    if (!result.ok) return err(result.reason);
    return ok({
      version: result.value.headers.get('x-version'),
      host: hostOf(this.#baseUrl),
    });
  }

  /**
   * Hand the bytes over. A task id means "accepted for consumption", not "stored" —
   * the outcome has to be read back from `getTask`.
   */
  async postDocument(
    file: UploadFile,
    fields: Readonly<Record<string, string>> = {},
  ): Promise<ApiResult<string>> {
    const makeFormData = this.#config.formData ?? defaultFormData;
    let form: FormDataLike;
    try {
      form = makeFormData();
    } catch (error) {
      return err(classifyThrown(error));
    }

    form.append('document', file.part, file.filename);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    const result = await this.#request('api/documents/post_document/', {
      method: 'POST',
      body: form,
    });
    if (!result.ok) return err(result.reason);

    const body = await this.#readText(result.value);
    if (!body.ok) return err(body.reason);

    const taskId = parseTaskId(body.value);
    if (taskId === null) {
      return err({
        kind: 'rejected',
        status: result.value.status,
        message: `could not read a task id from the response: ${truncate(body.value)}`,
      });
    }
    return ok(taskId);
  }

  /** Read the consumption task. Absent means the server has forgotten it. */
  async getTask(taskId: string): Promise<ApiResult<PaperlessTask | null>> {
    const result = await this.#json<PaperlessTask[] | { results?: PaperlessTask[] }>(
      `api/tasks/?task_id=${encodeURIComponent(taskId)}`,
    );
    if (!result.ok) return err(result.reason);
    const rows = Array.isArray(result.value) ? result.value : (result.value.results ?? []);
    return ok(rows.find((row) => row.task_id === taskId) ?? rows[0] ?? null);
  }

  /**
   * Paperless's own classifier, trained on this user's corpus. Returns ids, not
   * names — resolving those is the caller's job, using the cached lists below.
   */
  async getSuggestions(documentId: number): Promise<ApiResult<RawSuggestions>> {
    return this.#json<RawSuggestions>(`api/documents/${documentId}/suggestions/`);
  }

  async patchDocument(documentId: number, patch: DocumentPatch): Promise<ApiResult<null>> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['title'] = patch.title;
    if (patch.correspondent !== undefined) body['correspondent'] = patch.correspondent;
    if (patch.document_type !== undefined) body['document_type'] = patch.document_type;
    if (patch.tags !== undefined) body['tags'] = patch.tags;
    if (patch.created !== undefined) body['created'] = patch.created;

    const result = await this.#request(`api/documents/${documentId}/`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return result.ok ? ok(null) : err(result.reason);
  }

  /**
   * Find a document by the content hash we named it with.
   *
   * Fails towards "not found" at every step. A wrong negative costs one redundant
   * upload that the server refuses as a duplicate; a wrong positive would let a
   * retention policy delete the only copy of a document that never arrived.
   */
  async findByCaptureId(sha256: string): Promise<ApiResult<number | null>> {
    const filename = captureFilename(sha256);
    const result = await this.#json<{ results?: readonly DocumentSummary[] }>(
      `api/documents/?original_filename__istartswith=${encodeURIComponent(filename)}&page_size=25&ordering=id`,
    );
    if (!result.ok) return err(result.reason);

    // Re-check every candidate. If the server ignored the filter, this page is
    // just "some documents", and none of them will carry our filename.
    const confirmed = (result.value.results ?? [])
      .filter((row) => matchesCaptureId(row.original_filename, sha256))
      .map((row) => row.id)
      .sort((a, b) => a - b);

    return ok(confirmed[0] ?? null);
  }

  /**
   * Check that `original_filename__istartswith` actually filters on this server.
   *
   * DRF ignores query parameters it does not recognise, so an unsupported filter
   * looks like a successful search that matched everything. We search for a
   * filename that cannot exist: an empty result means the filter works, and any
   * result at all means it was ignored.
   *
   * Reconciliation stays safe either way -- findByCaptureId re-checks filenames --
   * but knowing tells us whether recovery costs one request or one re-upload, and
   * it belongs in the diagnostics screen rather than in a surprise.
   */
  async probeReconciliation(): Promise<ApiResult<ReconcileProbe>> {
    const total = await this.#json<{ count?: number }>('api/documents/?page_size=1');
    if (!total.ok) return err(total.reason);
    const documentCount = total.value.count ?? 0;

    if (documentCount === 0) {
      return ok({
        filterSupported: false,
        conclusive: false,
        detail: 'the server has no documents yet, so the filter cannot be tested',
      });
    }

    const impossible = captureFilename('0'.repeat(64));
    const probe = await this.#json<{ count?: number; results?: readonly DocumentSummary[] }>(
      `api/documents/?original_filename__istartswith=${encodeURIComponent(impossible)}&page_size=1`,
    );
    if (!probe.ok) return err(probe.reason);

    const matched = probe.value.count ?? probe.value.results?.length ?? 0;
    return ok(
      matched === 0
        ? { filterSupported: true, conclusive: true, detail: 'filter narrows results as expected' }
        : {
            filterSupported: false,
            conclusive: true,
            detail: 'the server ignored the filter and answered with unrelated documents',
          },
    );
  }

  getCorrespondents(): Promise<ApiResult<readonly NamedResource[]>> {
    return this.#listAll('api/correspondents/');
  }

  getDocumentTypes(): Promise<ApiResult<readonly NamedResource[]>> {
    return this.#listAll('api/document_types/');
  }

  getTags(): Promise<ApiResult<readonly NamedResource[]>> {
    return this.#listAll('api/tags/');
  }

  async #listAll(path: string): Promise<ApiResult<readonly NamedResource[]>> {
    const collected: NamedResource[] = [];
    let next: string | null = `${path}?page_size=200`;
    // Bounded so a server that keeps handing back a `next` cannot spin forever.
    for (let page = 0; next !== null && page < 50; page++) {
      const result: ApiResult<{ results?: NamedResource[]; next?: string | null }> =
        await this.#json(next);
      if (!result.ok) return err(result.reason);
      collected.push(...(result.value.results ?? []));
      const following: string | null = result.value.next ?? null;
      next = following === null ? null : relativize(following, this.#baseUrl);
    }
    return ok(collected);
  }

  async #json<T>(path: string): Promise<ApiResult<T>> {
    const result = await this.#request(path, { method: 'GET' });
    if (!result.ok) return err(result.reason);
    const body = await this.#readText(result.value);
    if (!body.ok) return err(body.reason);
    try {
      return ok(JSON.parse(body.value) as T);
    } catch {
      return err({
        kind: 'rejected',
        status: result.value.status,
        message: `expected JSON, got: ${truncate(body.value)}`,
      });
    }
  }

  async #readText(response: { text(): Promise<string> }): Promise<ApiResult<string>> {
    try {
      return ok(await response.text());
    } catch (error) {
      return err(this.#classify(error));
    }
  }

  /** The single place a request is made, so auth, timeout and redaction are unskippable. */
  async #request(
    path: string,
    init: HttpRequest,
  ): Promise<ApiResult<Awaited<ReturnType<PaperlessConfig['fetch']>>>> {
    const url = joinUrl(this.#baseUrl, path);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#config.fetch(url, {
        ...init,
        headers: {
          accept: 'application/json',
          ...init.headers,
          authorization: `Token ${this.#token}`,
        },
        ...(controller === null ? {} : { signal: controller.signal }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return err(
          classifyResponse(
            response.status,
            redact(body, this.#token),
            response.headers.get('retry-after') ?? undefined,
          ),
        );
      }
      return ok(response);
    } catch (error) {
      return err(this.#classify(error));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  #classify(error: unknown): ReturnType<typeof classifyThrown> {
    const reason = classifyThrown(error);
    // A TLS message can echo back configuration; scrub it like anything else.
    if (reason.kind === 'tls') {
      return { kind: 'tls', detail: redact(reason.detail, this.#token) };
    }
    return reason;
  }
}

/** Paperless returns the task id as a bare JSON string: `"a3f9…"`. */
function parseTaskId(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string' && parsed.length > 0) return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const id = (parsed as Record<string, unknown>)['task_id'];
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return null;
  } catch {
    // Some versions/proxies return it unquoted.
    return /^[\w-]{8,}$/.test(trimmed) ? trimmed : null;
  }
}

function relativize(absolute: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return absolute.startsWith(base) ? absolute.slice(base.length + 1) : absolute;
}

function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function defaultFormData(): FormDataLike {
  const Ctor = (globalThis as { FormData?: new () => FormDataLike }).FormData;
  if (!Ctor) throw new Error('no FormData implementation available on this platform');
  return new Ctor();
}
