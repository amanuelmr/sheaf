import type { DocState, Suggestions } from '@sheaf/core';
import type { EngineApi } from '@sheaf/engine';
import {
  PaperlessClient,
  captureFilename,
  err,
  ok,
  resolveSuggestions,
  type ApiResult,
  type FetchLike,
  type NamedResource,
} from '@sheaf/paperless';
import { pdfFile } from './files';

interface Vocabulary {
  correspondents: readonly NamedResource[];
  documentTypes: readonly NamedResource[];
  tags: readonly NamedResource[];
}

const EMPTY: Vocabulary = { correspondents: [], documentTypes: [], tags: [] };
const VOCABULARY_TTL_MS = 10 * 60_000;

/**
 * `EngineApi` over the real client.
 *
 * The vocabulary is cached because suggestions come back as ids and the engine
 * should not pay three round trips to name one document. A stale cache degrades to
 * a dropped suggestion, never to a wrong one.
 */
export class PaperlessAdapter implements EngineApi {
  private vocabulary: Vocabulary = EMPTY;
  private fetchedAt = 0;

  constructor(
    private readonly client: PaperlessClient,
    private readonly now: () => number,
  ) {}

  async postDocument(state: DocState): Promise<ApiResult<string>> {
    const file = pdfFile(state.sha256);
    if (!file.exists) {
      // The bytes are gone, so no amount of retrying will help. Say so plainly
      // rather than looping forever on a document that cannot be sent.
      return err({
        kind: 'rejected',
        status: 0,
        message: 'the local copy of this document is missing',
      });
    }
    const filename = captureFilename(state.sha256);
    return this.client.postDocument({
      part: { uri: file.uri, name: filename, type: 'application/pdf' },
      filename,
    });
  }

  getTask(taskId: string) {
    return this.client.getTask(taskId);
  }

  findByCaptureId(sha256: string) {
    return this.client.findByCaptureId(sha256);
  }

  async getSuggestions(remoteId: number): Promise<ApiResult<Suggestions>> {
    const raw = await this.client.getSuggestions(remoteId);
    if (!raw.ok) return err(raw.reason);
    await this.refreshVocabulary();
    return ok(resolveSuggestions(raw.value, this.vocabulary));
  }

  patchDocument(remoteId: number, patch: Parameters<EngineApi['patchDocument']>[1]) {
    return this.client.patchDocument(remoteId, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.correspondentId === undefined ? {} : { correspondent: patch.correspondentId }),
      ...(patch.documentTypeId === undefined ? {} : { document_type: patch.documentTypeId }),
      ...(patch.tagIds === undefined ? {} : { tags: patch.tagIds }),
      ...(patch.createdDate === undefined ? {} : { created: patch.createdDate }),
    });
  }

  /** Names for the triage screen, and for turning suggestions into words. */
  async namesFor(): Promise<Vocabulary> {
    await this.refreshVocabulary();
    return this.vocabulary;
  }

  private async refreshVocabulary(): Promise<void> {
    if (this.now() - this.fetchedAt < VOCABULARY_TTL_MS && this.vocabulary !== EMPTY) return;
    const [correspondents, documentTypes, tags] = await Promise.all([
      this.client.getCorrespondents(),
      this.client.getDocumentTypes(),
      this.client.getTags(),
    ]);
    if (!correspondents.ok || !documentTypes.ok || !tags.ok) return; // keep what we had
    this.vocabulary = {
      correspondents: correspondents.value,
      documentTypes: documentTypes.value,
      tags: tags.value,
    };
    this.fetchedAt = this.now();
  }
}

export function createClient(config: { baseUrl: string; token: string }): PaperlessClient {
  // A DOM Response structurally satisfies HttpResponse, so the platform fetch
  // drops straight in; only the request init needs a cast.
  const transport: FetchLike = (url, init) => fetch(url, init as RequestInit);
  return new PaperlessClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetch: transport,
    formData: () => new FormData(),
    timeoutMs: 30_000,
  });
}
