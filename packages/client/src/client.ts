import {
  classifyResponse,
  classifyThrown,
  err,
  joinUrl,
  ok,
  redact,
  type ApiResult,
  type FetchLike,
  type HttpRequest,
  type HttpResponse,
} from '@sheaf/http';
import {
  DOCUMENT_CONTENT_TYPE,
  authorization,
  paths,
  type DocumentPatch,
  type DocumentRecord,
  type HealthResponse,
  type ListResponse,
  type PutOutcome,
} from '@sheaf/protocol';
import { interpretPutStatus } from './put.ts';

export interface SheafConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Client for the Sheaf ingestion protocol.
 *
 * Thinner than its predecessor, and the reason is the protocol rather than the
 * code: there is no task to poll, no duplicate message to parse, and no filtered
 * search whose filter might be ignored. Each of those was a workaround for talking
 * to a server we did not design.
 *
 * The token lives in a private field and is scrubbed from anything that could
 * escape as text.
 */
export class SheafClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(config: SheafConfig) {
    this.#token = config.token;
    this.#baseUrl = config.baseUrl;
    this.#fetch = config.fetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Never let the token ride along in a stringified client. */
  toJSON(): Record<string, string> {
    return { baseUrl: this.#baseUrl, token: '[redacted]' };
  }

  /** Reachable, speaking our protocol, and accepting this token. */
  async testConnection(): Promise<ApiResult<HealthResponse>> {
    return this.#json<HealthResponse>('GET', paths.health());
  }

  /**
   * Does the server already hold this document?
   *
   * A status code, not a search result. The predecessor had to filter a list, and a
   * server that did not support the filter answered with an unfiltered page --
   * which would have been read as "yes" about a document it had never seen.
   */
  async hasDocument(sha256: string): Promise<ApiResult<boolean>> {
    const result = await this.#request('HEAD', paths.document(sha256), {});
    if (!result.ok) {
      return result.reason.kind === 'not_found' ? ok(false) : err(result.reason);
    }
    return ok(true);
  }

  /** Upload. Sending the same bytes to the same address again is free. */
  async putDocument(
    sha256: string,
    body: unknown,
    pageCount?: number,
  ): Promise<ApiResult<PutOutcome>> {
    const headers: Record<string, string> = { 'content-type': DOCUMENT_CONTENT_TYPE };
    if (pageCount !== undefined) headers['x-sheaf-page-count'] = String(pageCount);

    const result = await this.#request('PUT', paths.document(sha256), { headers, body });
    if (result.ok) return interpretPutStatus(result.value.status);
    return err(result.reason);
  }

  async patchDocument(sha256: string, patch: DocumentPatch): Promise<ApiResult<DocumentRecord>> {
    return this.#json<DocumentRecord>('PATCH', paths.document(sha256), JSON.stringify(patch));
  }

  async listDocuments(): Promise<ApiResult<readonly DocumentRecord[]>> {
    const result = await this.#json<ListResponse>('GET', paths.documents());
    return result.ok ? ok(result.value.documents) : err(result.reason);
  }

  async #json<T>(method: string, path: string, body?: string): Promise<ApiResult<T>> {
    const init: HttpRequest =
      body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body };
    const result = await this.#request(method, path, init);
    if (!result.ok) return err(result.reason);

    try {
      const text = await result.value.text();
      return ok(JSON.parse(text) as T);
    } catch (error) {
      return err(this.#classify(error));
    }
  }

  /** The one place a request is made, so auth, timeout and redaction are unskippable. */
  async #request(
    method: string,
    path: string,
    init: HttpRequest,
  ): Promise<ApiResult<HttpResponse>> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller === null ? null : setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(joinUrl(this.#baseUrl, path), {
        ...init,
        method,
        headers: {
          accept: 'application/json',
          ...init.headers,
          authorization: authorization(this.#token),
        },
        ...(controller === null ? {} : { signal: controller.signal }),
      });

      // A PUT answers 200 or 201 and both are success, so the caller interprets the
      // status itself rather than having `ok` decide for it.
      if (method === 'PUT' && (response.status === 200 || response.status === 201)) {
        return ok(response);
      }
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
    if (reason.kind === 'tls') return { kind: 'tls', detail: redact(reason.detail, this.#token) };
    return reason;
  }
}
