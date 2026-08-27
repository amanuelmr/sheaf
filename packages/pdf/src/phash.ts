import { decodeDc, type DcImage } from './dcscan.ts';

/**
 * "Have I photographed this page before?"
 *
 * The content hash the rest of the system runs on answers a different question, and
 * answers it perfectly: identical bytes, identical document. But photographing the
 * same receipt twice never produces identical bytes -- different noise, exposure and
 * framing every time -- so exact hashing has nothing at all to say about the case
 * §26 actually describes, which is a person scanning something they already scanned.
 *
 * ## Why this is not a difference hash
 *
 * The obvious answer is dHash: shrink the image to a small grid and record whether
 * each cell is brighter than the one beside it. Measured on document photographs, it
 * does not work, and the reason is specific to documents. A page is mostly paper.
 * Two neighbouring cells of blank paper differ by almost nothing, so the bit
 * recording which is brighter is decided by sensor noise -- and roughly half the
 * hash ends up being a coin toss. Re-photographing one page produced Hamming
 * distances of 17-30%, overlapping completely with the distances between entirely
 * different documents.
 *
 * So this measures where the ink is instead. Each 8x8 block is called ink or paper
 * by comparing it against the midpoint of the page's own brightness range, and each
 * cell of a 16x16 grid records whether it holds more ink than the page averages.
 * "Is there writing here" survives exposure, noise and JPEG quality in a way that
 * "is this white marginally brighter than that white" does not.
 *
 * ## What the numbers were
 *
 * Across 48 renderings of 12 document layouts, varying exposure, contrast, sensor
 * noise, JPEG quality from 55 to 90, sub-pixel rotation and a few pixels of
 * translation, plus dust specks and specular highlights:
 *
 *   - the same page photographed again: 0-7% of bits differ
 *   - two different documents: 5.9% at the closest, almost all far above
 *
 * At the threshold below, 85% of re-captures are recognised and *none* of the 1056
 * different-document pairs raised a false alarm. That direction is deliberate. §26
 * is explicit that a missed duplicate costs almost nothing while a wrong accusation
 * costs trust, so the threshold is set where it errs towards silence.
 *
 * Two honest caveats. These were rendered document-like images, not photographs of
 * real paper; the shape of the result should hold, but the exact numbers are from a
 * simulation. And this is a reason to *ask*, never a reason to act -- nothing here
 * decides anything on its own.
 */

const GRID = 16;
export const HASH_BITS = GRID * GRID;

/**
 * The page needs some range between its darkest and lightest parts before "ink" and
 * "paper" mean anything. Below this it is a blank sheet or a photograph of a wall,
 * and every one of those would hash alike -- which would make blank pages match each
 * other, the one false positive guaranteed to happen in real use.
 */
const MIN_CONTRAST = 24;

/**
 * How unevenly the ink has to be spread before the layout means anything.
 *
 * The same coin-toss problem as blank paper, one level up. If every cell holds
 * about the same amount of ink -- a solid block of texture with no margins and no
 * structure -- then whether a cell lands above or below the average is decided by
 * a rounding difference, and two unrelated images of that kind would match.
 *
 * Measured: real document pages score 0.17 to 0.25 here, and a uniformly textured
 * image scores 0.03. The guard sits in the gap, well clear of both.
 */
const MIN_LAYOUT_SPREAD = 0.06;

/** 256 bits as 64 lowercase hex characters. */
export type PageHash = string;

/**
 * How many bits may differ before two captures are worth mentioning to someone.
 *
 * 13 of 256, which is 5%. Chosen from the measurements above rather than from
 * folklore, and sitting in the gap between the two distributions.
 */
export const SIMILAR_ENOUGH_TO_ASK = 13;

/**
 * The hash of an image already decoded. Exported so the guards below can be tested
 * against images built to trip them, rather than against a JPEG that happens to.
 */
export function hashDcImage(image: DcImage): PageHash | null {
  if (image.across < GRID || image.down < GRID) return null;
  return hashCells(image);
}

function hashCells(image: DcImage): PageHash | null {
  let lo = 255;
  let hi = 0;
  for (const value of image.luma) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (hi - lo < MIN_CONTRAST) return null;

  const midpoint = (lo + hi) / 2;
  const ink = new Float64Array(GRID * GRID);
  const counts = new Float64Array(GRID * GRID);

  for (let y = 0; y < image.down; y++) {
    const row = Math.min(GRID - 1, Math.floor((y * GRID) / image.down));
    for (let x = 0; x < image.across; x++) {
      const column = Math.min(GRID - 1, Math.floor((x * GRID) / image.across));
      const at = row * GRID + column;
      // Binarised before averaging, which is the whole point: a blank cell scores a
      // clean zero rather than a noisy near-zero.
      ink[at] = ink[at]! + (image.luma[y * image.across + x]! < midpoint ? 1 : 0);
      counts[at] = counts[at]! + 1;
    }
  }

  let total = 0;
  for (let i = 0; i < ink.length; i++) {
    if (counts[i]! > 0) ink[i] = ink[i]! / counts[i]!;
    total += ink[i]!;
  }
  const average = total / ink.length;

  let spread = 0;
  for (const value of ink) spread += Math.abs(value - average);
  if (spread / ink.length < MIN_LAYOUT_SPREAD) return null;

  let hex = '';
  for (let i = 0; i < ink.length; i += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit++) {
      nibble = (nibble << 1) | (ink[i + bit]! > average ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Null whenever we have no opinion: a progressive or truncated JPEG, an image too
 * small to reduce, a page with too little contrast to call anything ink, or one
 * whose ink is spread so evenly that it has no layout to recognise. Silence is the
 * right answer to a question we cannot answer.
 */
export function pageHash(jpeg: Uint8Array): PageHash | null {
  const image = decodeDc(jpeg);
  return image === null ? null : hashDcImage(image);
}

const POPCOUNT = new Uint8Array(16);
for (let i = 0; i < 16; i++)
  POPCOUNT[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);

/** How many of the 256 judgements disagree. */
export function hammingDistance(a: PageHash, b: PageHash): number {
  if (a.length !== b.length) return HASH_BITS;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += POPCOUNT[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  }
  return distance;
}

export function looksLikeTheSamePage(a: PageHash, b: PageHash): boolean {
  return hammingDistance(a, b) <= SIMILAR_ENOUGH_TO_ASK;
}

export interface SimilarPage<T> {
  readonly value: T;
  /** How many of the 256 judgements differ. Smaller is more alike. */
  readonly distance: number;
}

/**
 * The earlier capture this one most looks like, or null if none is close enough.
 *
 * Linear, and deliberately so: comparing 256 bits is a handful of XORs, and a phone
 * holding a thousand documents finishes this before the shutter animation does.
 * Candidates with no hash are skipped rather than counted as different, because
 * "we could not look" is not the same claim as "it is not there".
 */
export function mostSimilarPage<T>(
  hash: PageHash,
  candidates: Iterable<{ readonly pageHash: string | null; readonly value: T }>,
): SimilarPage<T> | null {
  let best: SimilarPage<T> | null = null;
  for (const candidate of candidates) {
    if (candidate.pageHash === null) continue;
    const distance = hammingDistance(hash, candidate.pageHash);
    if (distance > SIMILAR_ENOUGH_TO_ASK) continue;
    if (best === null || distance < best.distance) best = { value: candidate.value, distance };
  }
  return best;
}
