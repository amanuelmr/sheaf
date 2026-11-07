import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { MAX_DOCUMENT_BYTES } from '@sheaf/protocol';
import { collate } from './pdf-edit.ts';
import { sha256Hex, type Storage } from './storage.ts';

export interface ConsumeOptions {
  /** Each subfolder a file sits in becomes a tag on it. */
  readonly subdirsAsTags: boolean;
  /**
   * A subfolder for double-sided scans from a one-sided feeder: the fronts, then
   * the backs, as two files. Null: none.
   */
  readonly doubleSided?: string | null;
  now(): number;
}

export interface ConsumeResult {
  readonly stored: number;
  readonly duplicates: number;
  readonly failed: number;
}

/** Where files that cannot be taken in are moved, inside the folder itself. */
export const FAILED_DIR = 'failed';

/** Where the fronts of a double-sided scan wait for their backs, hidden from the folder walk. */
const FRONTS = '.fronts.pdf';
/** Fronts older than this are taken to be abandoned: the next file starts a new pair. */
const PAIR_WINDOW_MS = 30 * 60_000;

/**
 * Takes in PDFs dropped into a folder, as a scanner or a sync tool would leave them.
 *
 * A file is read only once it has been the same size on two passes in a row, so a
 * scan still being written is left alone. Once stored it is removed from the
 * folder: the server holds it now. Anything that is not a PDF, or too large, is
 * moved to `failed/` rather than deleted, for a person to look at.
 */
export class ConsumeFolder {
  readonly #storage: Storage;
  readonly #dir: string;
  readonly #options: ConsumeOptions;
  /** Each file's size on the last pass. */
  #sizes = new Map<string, number>();

  constructor(storage: Storage, dir: string, options: ConsumeOptions) {
    this.#storage = storage;
    this.#dir = dir;
    this.#options = options;
  }

  async tick(): Promise<ConsumeResult> {
    let stored = 0;
    let duplicates = 0;
    let failed = 0;
    const sizes = new Map<string, number>();
    for (const path of this.#files(this.#dir)) {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue; // gone between listing and looking
      }
      sizes.set(path, size);
      if (this.#sizes.get(path) !== size) continue; // new, or still growing
      sizes.delete(path);

      const outcome = await this.#take(path, size);
      if (outcome === 'stored') stored++;
      else if (outcome === 'already-stored') duplicates++;
      else if (outcome === 'failed') failed++;
    }
    this.#sizes = sizes;
    return { stored, duplicates, failed };
  }

  async #take(
    path: string,
    size: number,
  ): Promise<'stored' | 'already-stored' | 'failed' | 'waiting'> {
    if (size === 0 || size > MAX_DOCUMENT_BYTES || !path.toLowerCase().endsWith('.pdf')) {
      this.#fail(path);
      return 'failed';
    }
    const bytes = new Uint8Array(readFileSync(path));
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      this.#fail(path);
      return 'failed';
    }
    let folders = relative(this.#dir, dirname(path))
      .split(sep)
      .filter((part) => part !== '');
    let document: Uint8Array = bytes;
    const doubleSided = this.#options.doubleSided ?? null;
    if (doubleSided !== null && folders[0] === doubleSided) {
      const paired = await this.#pair(path, bytes);
      if (paired === 'waiting') return 'waiting';
      if (paired === 'failed') return 'failed';
      document = paired;
      folders = folders.slice(1);
    }
    const sha256 = sha256Hex(document);
    const outcome = await this.#storage.put(sha256, document, this.#options.now(), null);
    if (this.#options.subdirsAsTags && folders.length > 0) {
      await this.#storage.addTags(sha256, folders);
    }
    if (existsSync(path)) unlinkSync(path);
    return outcome;
  }

  /**
   * The first file of a pair waits as the fronts; the second is the backs, and the
   * two become one document. Fronts left waiting too long are replaced.
   */
  async #pair(path: string, bytes: Uint8Array): Promise<Uint8Array | 'waiting' | 'failed'> {
    const fronts = join(this.#dir, this.#options.doubleSided!, FRONTS);
    const waiting =
      existsSync(fronts) && this.#options.now() - statSync(fronts).mtimeMs < PAIR_WINDOW_MS;
    if (!waiting) {
      mkdirSync(dirname(fronts), { recursive: true });
      renameSync(path, fronts);
      return 'waiting';
    }
    try {
      const document = await collate(new Uint8Array(readFileSync(fronts)), bytes);
      unlinkSync(fronts);
      return document;
    } catch {
      // Not a pair: both go where a person will look, and the next file starts afresh.
      this.#fail(path);
      const target = join(this.#dir, FAILED_DIR, `${String(this.#options.now())}-fronts.pdf`);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(fronts, target);
      return 'failed';
    }
  }

  #fail(path: string): void {
    const target = join(this.#dir, FAILED_DIR, relative(this.#dir, path));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(path, target);
  }

  /** Every file under the folder, leaving out `failed/` and hidden files. */
  *#files(dir: string): Generator<string> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === this.#dir && entry.name === FAILED_DIR) continue;
        yield* this.#files(path);
      } else if (entry.isFile()) {
        yield path;
      }
    }
  }
}
