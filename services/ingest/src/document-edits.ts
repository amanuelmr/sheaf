import type { PageSpec } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { editPages, mergePdfs, pageCount, splitPdf } from './pdf-edit.ts';
import { sha256Hex, type ReplaceOutcome, type Storage } from './storage.ts';

export type EditRefusal =
  | { readonly ok: false; readonly kind: 'not_found' }
  | { readonly ok: false; readonly kind: 'invalid'; readonly message: string }
  | { readonly ok: false; readonly kind: 'conflict'; readonly message: string };

/**
 * Changing a document's pages, or making new documents from its pages.
 *
 * Editing keeps the document: it moves to the new file and the old one stays as an
 * earlier version. Splitting and merging make new documents that start out filed
 * the way their source was, and, unless asked otherwise, put the sources in the
 * trash, where they can be restored from.
 */
export class DocumentEdits {
  readonly #storage: Storage;
  readonly #driver: SqlDriver;

  constructor(storage: Storage, driver: SqlDriver) {
    this.#storage = storage;
    this.#driver = driver;
  }

  async pages(sha256: string): Promise<number | null> {
    const bytes = this.#storage.bytes(sha256);
    return bytes === null ? null : pageCount(bytes);
  }

  async editPages(
    sha256: string,
    pages: readonly PageSpec[],
    now: number,
  ): Promise<{ ok: true; sha256: string } | EditRefusal> {
    const bytes = await this.#live(sha256);
    if (bytes === null) return { ok: false, kind: 'not_found' };
    let edited: Uint8Array;
    try {
      edited = await editPages(bytes, pages);
    } catch (error) {
      return { ok: false, kind: 'invalid', message: reason(error) };
    }
    return answer(await this.#storage.replaceFile(sha256, edited, pages.length, now));
  }

  async split(
    sha256: string,
    parts: readonly (readonly number[])[],
    keepOriginal: boolean,
    now: number,
  ): Promise<{ ok: true; documents: string[] } | EditRefusal> {
    const bytes = await this.#live(sha256);
    const record = await this.#storage.record(sha256);
    if (bytes === null || record === null) return { ok: false, kind: 'not_found' };
    let pieces: Uint8Array[];
    try {
      pieces = await splitPdf(bytes, parts);
    } catch (error) {
      return { ok: false, kind: 'invalid', message: reason(error) };
    }
    const made: string[] = [];
    for (const [i, piece] of pieces.entries()) {
      const title = record.title ?? record.suggestions?.title ?? null;
      made.push(
        await this.#store(piece, parts[i]!.length, now, {
          title: title === null ? null : `${title} (${String(i + 1)} of ${String(pieces.length)})`,
          correspondent: record.correspondent,
          documentType: record.documentType,
          tags: record.tags,
          created: record.created,
        }),
      );
    }
    if (!keepOriginal && !made.includes(sha256)) await this.#storage.trash(sha256, now);
    return { ok: true, documents: made };
  }

  async merge(
    documents: readonly string[],
    keepOriginals: boolean,
    now: number,
  ): Promise<{ ok: true; sha256: string } | EditRefusal> {
    const files: Uint8Array[] = [];
    const tags: string[] = [];
    for (const sha256 of documents) {
      const bytes = await this.#live(sha256);
      if (bytes === null) {
        return {
          ok: false,
          kind: 'invalid',
          message: `document ${sha256.slice(0, 12)}… is not here, or has no file`,
        };
      }
      files.push(bytes);
      tags.push(...((await this.#storage.record(sha256))?.tags ?? []));
    }
    let merged: Uint8Array;
    try {
      merged = await mergePdfs(files);
    } catch (error) {
      return { ok: false, kind: 'invalid', message: reason(error) };
    }
    const first = (await this.#storage.record(documents[0]!))!;
    const sha256 = await this.#store(merged, await pageCount(merged), now, {
      title: first.title ?? first.suggestions?.title ?? null,
      correspondent: first.correspondent,
      documentType: first.documentType,
      tags: [...new Set(tags)],
      created: first.created,
    });
    if (!keepOriginals) {
      for (const original of documents)
        if (original !== sha256) await this.#storage.trash(original, now);
    }
    return { ok: true, sha256 };
  }

  /** Bytes of a document that is here, outside the trash, with its file. */
  async #live(sha256: string): Promise<Uint8Array | null> {
    const record = await this.#storage.record(sha256);
    if (record === null || record.trashedAt !== undefined) return null;
    return this.#storage.bytes(sha256);
  }

  /** Store a new document filed as given. It came from documents already filed, so rules and inbox tags are not applied to it again. */
  async #store(
    bytes: Uint8Array,
    pages: number,
    now: number,
    filing: Parameters<Storage['fileByMachine']>[1],
  ): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const outcome = await this.#storage.put(sha256, bytes, now, pages);
    if (outcome === 'stored') {
      await this.#storage.fileByMachine(sha256, filing);
      await this.#driver.run(
        `INSERT OR IGNORE INTO jobs (sha256, step, version, state, attempts, created_at)
         VALUES (?, 'match', 1, 'done', 0, ?)`,
        [sha256, now],
      );
    }
    return sha256;
  }
}

function answer(outcome: ReplaceOutcome): { ok: true; sha256: string } | EditRefusal {
  switch (outcome.kind) {
    case 'replaced':
    case 'unchanged':
      return { ok: true, sha256: outcome.sha256 };
    case 'exists':
      return {
        ok: false,
        kind: 'conflict',
        message: `the edited file is already document ${outcome.sha256.slice(0, 12)}…`,
      };
    case 'not_found':
      return { ok: false, kind: 'not_found' };
  }
}

function reason(error: unknown): string {
  return error instanceof RangeError ? error.message : 'that file could not be read as a PDF';
}
