import type { SimilarDocument } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { visibleTo } from './storage.ts';

/**
 * Finding re-scans of the same paper by what they say, not by their bytes.
 *
 * Two scans of one letter never hash the same: the light, the crop and the OCR
 * differ. Their words mostly do not. Each document's text becomes a MinHash
 * signature of its word pairs: 64 numbers, where the share of numbers two
 * signatures have in common estimates how much of their word pairs they share.
 * Comparing signatures is cheap enough to check a new document against every
 * other one when its text arrives.
 */

export const SIGNATURE_SIZE = 64;
/** Shared word pairs from here up are taken for the same paper scanned twice. */
export const SAME_PAPER = 0.6;
/**
 * Of the numbers in either text, the share both must have. Two bills from one
 * company share nearly every word and differ in their amounts, dates and invoice
 * numbers; two scans of one bill have the same numbers, give or take a misread.
 */
export const SAME_NUMBERS = 0.7;
/** At most this many numbers are kept for each document. */
const MAX_NUMBERS = 200;
/** Fewer words than this says too little to tell one page from another. */
export const MIN_WORDS = 12;

const WORD = /[\p{L}\p{N}]+/gu;

/** Odd multipliers and offsets for the 64 hash functions, from a fixed seed. */
const SALTS: readonly (readonly [number, number])[] = (() => {
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length: SIGNATURE_SIZE }, () => [next() | 1, next()] as const);
})();

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The words of a text, folded the way search folds them. */
export function words(text: string): readonly string[] {
  return text.normalize('NFKC').toLowerCase().match(WORD) ?? [];
}

/** The signature of a text, or null when it has too few words to say anything. */
export function signature(text: string): Uint32Array | null {
  const all = words(text);
  if (all.length < MIN_WORDS) return null;
  const shingles = new Set<number>();
  for (let i = 0; i + 1 < all.length; i++) shingles.add(fnv1a(`${all[i]!} ${all[i + 1]!}`));
  const mins = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let k = 0; k < SIGNATURE_SIZE; k++) {
      const [a, b] = SALTS[k]!;
      let h = shingle ^ b;
      h ^= h >>> 16;
      h = Math.imul(h, a);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      h = (h ^ (h >>> 16)) >>> 0;
      if (h < mins[k]!) mins[k] = h;
    }
  }
  return mins;
}

/** The distinct numbers written in a text, sorted. */
export function numbers(text: string): readonly string[] {
  return [...new Set(words(text).filter((word) => /\p{N}/u.test(word)))]
    .sort()
    .slice(0, MAX_NUMBERS);
}

/**
 * Whether two texts' numbers agree well enough for them to be one paper. Texts
 * with hardly any numbers leave it to their words.
 */
export function numbersAgree(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < 2 && b.length < 2) return true;
  const theirs = new Set(b);
  const shared = a.filter((n) => theirs.has(n)).length;
  return shared / (a.length + b.length - shared) >= SAME_NUMBERS;
}

/** The share of word pairs two texts are estimated to have in common, 0 to 1. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let k = 0; k < SIGNATURE_SIZE; k++) if (a[k] === b[k]) same++;
  return same / SIGNATURE_SIZE;
}

export const encode = (sig: Uint32Array): string =>
  [...sig].map((n) => n.toString(16).padStart(8, '0')).join('');

export function decode(hex: string): Uint32Array {
  const sig = new Uint32Array(SIGNATURE_SIZE);
  for (let k = 0; k < SIGNATURE_SIZE; k++) sig[k] = parseInt(hex.slice(k * 8, k * 8 + 8), 16);
  return sig;
}

/** Signatures kept beside each document's text, and the comparisons made with them. */
export class NearDuplicates {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  /**
   * Works out a document's signature from its text again, and which earlier
   * document, if any, is most likely the same paper.
   */
  async update(sha256: string): Promise<void> {
    const texts = await this.#driver.all<{ text: string }>(
      'SELECT text FROM document_text WHERE sha256 = ? ORDER BY source',
      [sha256],
    );
    // Each source read the same page, so the longest reading stands for the document.
    const text = texts.map((t) => t.text).sort((a, b) => b.length - a.length)[0] ?? '';
    const sig = signature(text);
    if (sig === null) {
      await this.#driver.run('DELETE FROM text_signatures WHERE sha256 = ?', [sha256]);
      return;
    }
    const nums = numbers(text);
    const best = await this.#closest(sha256, sig, nums, null);
    await this.#driver.run(
      `INSERT INTO text_signatures (sha256, signature, numbers, twin, twin_similarity)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (sha256) DO UPDATE SET
         signature = excluded.signature, numbers = excluded.numbers, twin = excluded.twin,
         twin_similarity = excluded.twin_similarity`,
      [
        sha256,
        encode(sig),
        JSON.stringify(nums),
        best[0]?.sha256 ?? null,
        best[0]?.similarity ?? null,
      ],
    );
  }

  /** Gives every document with text but no signature one: for text kept before this existed. */
  async fillMissing(): Promise<number> {
    const missing = await this.#driver.all<{ sha256: string }>(
      `SELECT DISTINCT t.sha256 FROM document_text t
        WHERE NOT EXISTS (SELECT 1 FROM text_signatures s WHERE s.sha256 = t.sha256)
        ORDER BY t.received_at`,
    );
    for (const { sha256 } of missing) await this.update(sha256);
    return missing.length;
  }

  /** Documents this person may see that look like the same paper, most alike first. */
  async similarTo(sha256: string, viewer: number | null): Promise<readonly SimilarDocument[]> {
    const own = await this.#driver.all<{ signature: string; numbers: string }>(
      'SELECT signature, numbers FROM text_signatures WHERE sha256 = ?',
      [sha256],
    );
    if (own[0] === undefined) return [];
    return this.#closest(
      sha256,
      decode(own[0].signature),
      JSON.parse(own[0].numbers) as string[],
      viewer,
    );
  }

  async #closest(
    sha256: string,
    sig: Uint32Array,
    nums: readonly string[],
    viewer: number | null,
  ): Promise<SimilarDocument[]> {
    const visible = visibleTo(viewer);
    const rows = await this.#driver.all<{
      sha256: string;
      signature: string;
      numbers: string;
      title: string | null;
      received_at: number;
    }>(
      `SELECT s.sha256, s.signature, s.numbers, d.title, d.received_at
         FROM text_signatures s JOIN documents d ON d.sha256 = s.sha256
        WHERE s.sha256 <> ? AND d.trashed_at IS NULL AND ${visible.sql}`,
      [sha256, ...visible.params],
    );
    return rows
      .map((row) => ({
        sha256: row.sha256,
        title: row.title,
        receivedAt: row.received_at,
        similarity: similarity(sig, decode(row.signature)),
        numbers: row.numbers,
      }))
      .filter(
        (row) =>
          row.similarity >= SAME_PAPER && numbersAgree(nums, JSON.parse(row.numbers) as string[]),
      )
      .map((row) => ({
        sha256: row.sha256,
        title: row.title,
        receivedAt: row.receivedAt,
        similarity: row.similarity,
      }))
      .sort((a, b) => b.similarity - a.similarity || a.receivedAt - b.receivedAt)
      .slice(0, 5);
  }
}
