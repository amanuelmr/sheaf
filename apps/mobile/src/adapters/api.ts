import { SheafClient, interpretPutStatus } from '@sheaf/client';
import type { DocState, MetadataPatch, RemoteId, Suggestions } from '@sheaf/core';
import type { EngineApi, UploadAccepted } from '@sheaf/engine';
import { authorization, paths } from '@sheaf/protocol';
import { err, ok, joinUrl, type ApiResult, type FetchLike } from '@sheaf/http';
import { pdfFile } from './files';

export interface ServerConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * `EngineApi` over our own server.
 *
 * Markedly thinner than its predecessor, and the reason is the protocol rather
 * than the code. There is no task to poll, so `pollTask` is simply absent. There is
 * no duplicate message to parse, because both outcomes of a `PUT` are plain status
 * codes. And "do you already have this?" is one `HEAD`.
 */
export class SheafAdapter implements EngineApi {
  readonly #client: SheafClient;
  readonly #config: ServerConfig;

  constructor(config: ServerConfig, client: SheafClient) {
    this.#config = config;
    this.#client = client;
  }

  /**
   * Uploads by streaming the file from disk.
   *
   * Deliberately not `fetch` with the bytes in hand: a ten-page scan is tens of
   * megabytes, and reading it into the JavaScript heap to hand to `fetch` is how a
   * capture app runs out of memory on the document someone most wanted to keep.
   * `File.upload` streams it natively.
   */
  async postDocument(state: DocState): Promise<ApiResult<UploadAccepted>> {
    const file = pdfFile(state.sha256);
    if (!file.exists) {
      // The bytes are gone, so retrying cannot help. Say so rather than loop.
      return err({
        kind: 'rejected',
        status: 0,
        message: 'the local copy of this document is missing',
      });
    }

    try {
      const result = await file.upload(
        joinUrl(this.#config.baseUrl, paths.document(state.sha256)),
        {
          httpMethod: 'PUT',
          headers: {
            authorization: authorization(this.#config.token),
            'content-type': 'application/pdf',
            'x-sheaf-page-count': String(state.pages.length),
          },
        },
      );

      const outcome = interpretPutStatus(result.status);
      if (!outcome.ok) return err(outcome.reason);

      // The upload is authoritative, so there is nothing to poll. The document's
      // own hash is what the server knows it by.
      return ok({
        kind: 'confirmed',
        outcome:
          outcome.value === 'stored'
            ? { kind: 'stored', remoteId: state.sha256 }
            : { kind: 'duplicate', remoteId: state.sha256 },
      });
    } catch (error) {
      // A failed upload is expected and retryable; anything unexpected propagates.
      const message = error instanceof Error ? error.message : String(error);
      if (/certificate|self.signed|tls|ssl/i.test(message)) {
        return err({ kind: 'tls', detail: message.slice(0, 500) });
      }
      return err({ kind: 'unreachable' });
    }
  }

  /** One request, one status code. No search, and nothing to distrust. */
  async findByCaptureId(sha256: string): Promise<ApiResult<RemoteId | null>> {
    const result = await this.#client.hasDocument(sha256);
    if (!result.ok) return err(result.reason);
    return ok(result.value ? sha256 : null);
  }

  /**
   * Our server stores documents; it does not classify them. Answering "nothing to
   * suggest" is honest, and the engine records that it asked and stops — rather
   * than retrying an endpoint that will never have an opinion.
   */
  getSuggestions(): Promise<ApiResult<Suggestions>> {
    return Promise.resolve(ok({}));
  }

  /** Names in, names out. No vocabulary to look up, so nothing is dropped. */
  async patchDocument(remoteId: RemoteId, patch: MetadataPatch): Promise<ApiResult<null>> {
    const result = await this.#client.patchDocument(String(remoteId), {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.correspondent === undefined ? {} : { correspondent: patch.correspondent }),
      ...(patch.documentType === undefined ? {} : { documentType: patch.documentType }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
    });
    return result.ok ? ok(null) : err(result.reason);
  }
}

export function createClient(config: ServerConfig): SheafClient {
  // A DOM Response structurally satisfies HttpResponse, so the platform fetch drops
  // straight in; only the request init needs a cast.
  const transport: FetchLike = (url, init) => fetch(url, init as RequestInit);
  return new SheafClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetch: transport,
    timeoutMs: 30_000,
  });
}
