import {
  resolveDocument,
  type ArchivePatch,
  type BinaryFile,
  type DocumentQuery,
  type PaperlessClient,
  type ResolvedDocument,
} from '@sheaf/paperless';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { VocabularySource, Vocabulary } from './paperless-vocabulary.ts';

const PAGE_SIZE = 25;

export interface ArchiveSearchResult {
  readonly documents: readonly ResolvedDocument[];
  readonly count: number;
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The archive as something a phone can search and edit, without ever holding
 * Paperless's own token or knowing its API shape. Everything here is a live call
 * through to Paperless -- see `ArchiveDocument` in `@sheaf/protocol` for why
 * nothing is cached -- so a stale answer is never possible, only a slow one.
 */
export interface ArchiveSource {
  search(query: DocumentQuery): Promise<ApiResult<ArchiveSearchResult>>;
  get(id: number): Promise<ApiResult<ResolvedDocument>>;
  thumbnail(id: number): Promise<ApiResult<BinaryFile>>;
  patch(id: number, patch: ArchivePatch): Promise<ApiResult<ResolvedDocument>>;
  vocabulary(): Promise<Vocabulary>;
}

export function paperlessArchiveSource(
  client: PaperlessClient,
  vocabulary: VocabularySource,
): ArchiveSource {
  return {
    async search(query) {
      const raw = await client.listDocuments({ ...query, pageSize: PAGE_SIZE });
      if (!raw.ok) return err(raw.reason);
      const vocab = await vocabulary.get();
      const page = query.page ?? 1;
      return ok({
        documents: raw.value.results.map((row) => resolveDocument(row, vocab)),
        count: raw.value.count,
        page,
        hasMore: page * PAGE_SIZE < raw.value.count,
      });
    },

    async get(id) {
      const raw = await client.getDocument(id);
      if (!raw.ok) return err(raw.reason);
      return ok(resolveDocument(raw.value, await vocabulary.get()));
    },

    thumbnail: (id) => client.getDocumentThumbnail(id),

    async patch(id, patch) {
      const result = await client.patchDocument(id, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.correspondentId === undefined ? {} : { correspondent: patch.correspondentId }),
        ...(patch.documentTypeId === undefined ? {} : { document_type: patch.documentTypeId }),
        ...(patch.tagIds === undefined ? {} : { tags: patch.tagIds }),
      });
      if (!result.ok) return err(result.reason);

      // patchDocument answers only that the request landed; the archive is the
      // one truth about what the document now looks like, so read it back rather
      // than assemble a guess from what was sent.
      return this.get(id);
    },

    vocabulary: () => vocabulary.get(),
  };
}
