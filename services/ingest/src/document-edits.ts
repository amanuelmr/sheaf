import type { DocumentPermissions, PageSpec, StampBody, StampColour } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { editPages, mergePdfs, pageCount, splitPdf, stampPdf } from './pdf-edit.ts';

/** Ink colours, as a stamp pad would have them. */
const STAMP_RGB: Readonly<Record<StampColour, readonly [number, number, number]>> = {
  red: [0.75, 0.1, 0.1],
  blue: [0.1, 0.25, 0.7],
  green: [0.1, 0.5, 0.25],
  black: [0.1, 0.1, 0.1],
};
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
 * trash, where they can be restored from. New documents keep their source's owner
 * and sharing, so splitting or merging never shows a private document to anyone new.
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

  /** Stamps the document, keeping the unstamped file as an earlier version. */
  async stamp(
    sha256: string,
    body: StampBody,
    now: number,
  ): Promise<{ ok: true; sha256: string } | EditRefusal> {
    const bytes = await this.#live(sha256);
    if (bytes === null) return { ok: false, kind: 'not_found' };
    const lines = [body.text.trim().toUpperCase()];
    if (body.withDate !== false) lines.push(new Date(now).toISOString().slice(0, 10));
    let stamped: Uint8Array;
    try {
      stamped = await stampPdf(bytes, {
        lines,
        position: body.position ?? 'top-right',
        colour: STAMP_RGB[body.colour ?? 'red'],
        allPages: body.pages === 'all',
      });
    } catch (error) {
      return { ok: false, kind: 'invalid', message: reason(error) };
    }
    return answer(await this.#storage.replaceFile(sha256, stamped, await pageCount(stamped), now));
  }

  async split(
    sha256: string,
    parts: readonly (readonly number[])[],
    keepOriginal: boolean,
    now: number,
  ): Promise<{ ok: true; documents: string[] } | EditRefusal> {
    const bytes = await this.#live(sha256);
    const record = await this.#storage.record(sha256);
    const permissions = await this.#storage.permissions(sha256);
    if (bytes === null || record === null || permissions === null) {
      return { ok: false, kind: 'not_found' };
    }
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
        await this.#store(piece, parts[i]!.length, now, permissions, {
          title: title === null ? null : `${title} (${String(i + 1)} of ${String(pieces.length)})`,
          correspondent: record.correspondent,
          otherCorrespondents: record.otherCorrespondents ?? [],
          documentType: record.documentType,
          tags: record.tags,
          created: record.created,
        }),
      );
    }
    if (!keepOriginal && !made.includes(sha256)) await this.#storage.trash(sha256, now);
    return { ok: true, documents: made };
  }

  /**
   * `merger` is the person merging, or null for the admin token or a phone. The
   * merged document keeps its sources' owner when they share one; otherwise it
   * belongs to the merger alone, and without a person to own it the merge is refused.
   */
  async merge(
    documents: readonly string[],
    keepOriginals: boolean,
    now: number,
    merger: number | null = null,
  ): Promise<{ ok: true; sha256: string } | EditRefusal> {
    const files: Uint8Array[] = [];
    const tags: string[] = [];
    const sources: DocumentPermissions[] = [];
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
      sources.push((await this.#storage.permissions(sha256))!);
    }
    const permissions = mergedPermissions(sources, merger);
    if (permissions === null) {
      return {
        ok: false,
        kind: 'conflict',
        message: 'these documents belong to different people; sign in as a person to merge them',
      };
    }
    let merged: Uint8Array;
    try {
      merged = await mergePdfs(files);
    } catch (error) {
      return { ok: false, kind: 'invalid', message: reason(error) };
    }
    const first = (await this.#storage.record(documents[0]!))!;
    const sha256 = await this.#store(merged, await pageCount(merged), now, permissions, {
      title: first.title ?? first.suggestions?.title ?? null,
      correspondent: first.correspondent,
      otherCorrespondents: first.otherCorrespondents ?? [],
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

  /**
   * Split a document that just arrived, the way a separator sheet asks: the parts
   * are new arrivals, worked through like any other, and the bundle they came in
   * goes to the trash.
   */
  async splitArrival(
    sha256: string,
    parts: readonly (readonly number[])[],
    now: number,
  ): Promise<string[]> {
    const bytes = await this.#live(sha256);
    const permissions = await this.#storage.permissions(sha256);
    if (bytes === null || permissions === null) return [];
    const made: string[] = [];
    for (const [i, piece] of (await splitPdf(bytes, parts)).entries()) {
      const part = sha256Hex(piece);
      await this.#keep(part, piece, now, parts[i]!.length, permissions);
      made.push(part);
    }
    if (!made.includes(sha256)) await this.#storage.trash(sha256, now);
    return made;
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
    permissions: DocumentPermissions,
    filing: Parameters<Storage['fileByMachine']>[1],
  ): Promise<string> {
    const sha256 = sha256Hex(bytes);
    if (await this.#keep(sha256, bytes, now, pages, permissions)) {
      await this.#storage.fileByMachine(sha256, filing);
      await this.#driver.run(
        `INSERT OR IGNORE INTO jobs (sha256, step, version, state, attempts, created_at)
         VALUES (?, 'match', 1, 'done', 0, ?)`,
        [sha256, now],
      );
    }
    return sha256;
  }

  /**
   * Store bytes owned and shared as given; true when they are new. A document that
   * was already here keeps the owner and sharing it has.
   */
  async #keep(
    sha256: string,
    bytes: Uint8Array,
    now: number,
    pages: number,
    permissions: DocumentPermissions,
  ): Promise<boolean> {
    const outcome = await this.#storage.put(sha256, bytes, now, pages, null, permissions.owner);
    if (outcome !== 'stored') return false;
    if (permissions.grants.length > 0) await this.#storage.setPermissions(sha256, permissions);
    return true;
  }
}

/**
 * Who a merged document belongs to. Sources with one owner keep that owner, shared
 * with those all of them were shared with, at the lowest level any gave. Sources
 * with different owners make it the merger's alone; null when no person merged.
 */
export function mergedPermissions(
  sources: readonly DocumentPermissions[],
  merger: number | null,
): DocumentPermissions | null {
  const owner = sources[0]?.owner ?? null;
  if (sources.some((source) => source.owner !== owner)) {
    return merger === null ? null : { owner: merger, grants: [] };
  }
  const grants = (sources[0]?.grants ?? []).flatMap((grant) => {
    const levels = sources.map((s) => s.grants.find((g) => g.user === grant.user)?.level);
    if (levels.some((level) => level === undefined)) return [];
    return [{ user: grant.user, level: levels.includes('view') ? ('view' as const) : grant.level }];
  });
  return { owner, grants };
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
