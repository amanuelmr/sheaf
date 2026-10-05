import { err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentPatch } from '@sheaf/protocol';
import type { ArchivePatch, ResolvedDocument } from '@sheaf/paperless';
import type { ArchiveSearchResult, ArchiveSource } from './paperless-browse.ts';
import { toMatch } from './search-query.ts';
import type { ArchiveRow, NameKind, Storage } from './storage.ts';

/** The same page size the Paperless archive uses, so the phone pages the same way. */
const PAGE_SIZE = 25;

const EMPTY_PAGE = (page: number): ArchiveSearchResult => ({
  documents: [],
  count: 0,
  page,
  hasMore: false,
});

/**
 * The archive served from this server's own catalog (ADR 0007), for when there is no
 * Paperless, or the operator prefers Sheaf's own copy.
 *
 * It answers in exactly the shapes the Paperless archive does, so the phone's library
 * works against either without knowing which it is talking to. Thumbnails are the one
 * gap: this server renders nothing, so it answers "not found" and the phone shows its
 * placeholder, as it already does for a document with no thumbnail.
 */
export function nativeArchiveSource(storage: Storage): ArchiveSource {
  const nameOr = async (
    kind: NameKind,
    id: number | undefined,
  ): Promise<string | null | undefined> =>
    id === undefined ? undefined : storage.nameFor(kind, id);

  return {
    async search(query) {
      const page = query.page ?? 1;
      const match =
        query.text === undefined || query.text.trim() === '' ? null : toMatch(query.text);
      // Words were asked for but there were none to search by: nothing matches.
      if (query.text !== undefined && query.text.trim() !== '' && match === null) {
        return ok(EMPTY_PAGE(page));
      }

      const correspondent = await nameOr('correspondent', query.correspondentId);
      const documentType = await nameOr('document_type', query.documentTypeId);
      const tag = await nameOr('tag', query.tagId);
      // A filter by a name that does not exist matches nothing, rather than everything.
      if (correspondent === null || documentType === null || tag === null) {
        return ok(EMPTY_PAGE(page));
      }

      const { rows, total } = await storage.archivePage(
        {
          match,
          ...(correspondent === undefined ? {} : { correspondent }),
          ...(documentType === undefined ? {} : { documentType }),
          ...(tag === undefined ? {} : { tag }),
        },
        PAGE_SIZE,
        (page - 1) * PAGE_SIZE,
      );
      return ok({
        documents: rows.map(resolve),
        count: total,
        page,
        hasMore: page * PAGE_SIZE < total,
      });
    },

    async get(id) {
      const row = await storage.archiveRow(id);
      return row === null ? err({ kind: 'not_found' }) : ok(resolve(row));
    },

    thumbnail: () => Promise.resolve(err({ kind: 'not_found' })),

    async patch(id, patch) {
      const row = await storage.archiveRow(id);
      if (row === null) return err({ kind: 'not_found' });

      const changes = await toDocumentPatch(storage, patch);
      if (!changes.ok) return err(changes.reason);
      await storage.patch(row.sha256, changes.value);
      return this.get(id);
    },

    async vocabulary() {
      const [correspondents, documentTypes, tags] = await Promise.all([
        storage.names('correspondent'),
        storage.names('document_type'),
        storage.names('tag'),
      ]);
      return { correspondents, documentTypes, tags };
    },
  };
}

/**
 * The archive edits by vocabulary id; the catalog stores names. An id nobody issued is
 * refused rather than ignored, so a stale client finds out instead of silently losing
 * the edit.
 */
async function toDocumentPatch(
  storage: Storage,
  patch: ArchivePatch,
): Promise<ApiResult<DocumentPatch>> {
  const name = async (kind: NameKind, id: number | null | undefined) => {
    if (id === undefined || id === null) return { ok: true as const, value: id };
    const found = await storage.nameFor(kind, id);
    return found === null ? { ok: false as const } : { ok: true as const, value: found };
  };

  const correspondent = await name('correspondent', patch.correspondentId);
  const documentType = await name('document_type', patch.documentTypeId);
  const tags: string[] = [];
  for (const id of patch.tagIds ?? []) {
    const tag = await name('tag', id);
    if (!tag.ok) return unknown(`tag ${String(id)}`);
    tags.push(tag.value!);
  }
  if (!correspondent.ok) return unknown(`correspondent ${String(patch.correspondentId)}`);
  if (!documentType.ok) return unknown(`document type ${String(patch.documentTypeId)}`);

  return ok({
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(correspondent.value === undefined ? {} : { correspondent: correspondent.value }),
    ...(documentType.value === undefined ? {} : { documentType: documentType.value }),
    ...(patch.tagIds === undefined ? {} : { tags }),
  });
}

function unknown(what: string): ApiResult<never> {
  return err({ kind: 'rejected', status: 400, message: `no ${what} in this archive` });
}

function resolve(row: ArchiveRow): ResolvedDocument {
  return {
    id: row.id,
    title: row.title ?? `Scan ${row.sha256.slice(0, 8)}`,
    correspondent: row.correspondent,
    documentType: row.documentType,
    tags: row.tags,
    // A date, as Paperless gives one: when the server received it, in UTC.
    created: new Date(row.receivedAt).toISOString().slice(0, 10),
    contentSnippet: row.excerpt,
  };
}
