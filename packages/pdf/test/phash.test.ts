/**
 * Both halves of the claim, because only asserting one of them would be easy and
 * meaningless: a hash that returns a constant recognises every re-capture perfectly.
 *
 * The fixtures are renderings of document layouts, photographed under varying
 * exposure, contrast, sensor noise, JPEG quality, sub-pixel rotation and a few
 * pixels of translation. `d00_*` are four captures of one page; the others are
 * different documents.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe as suite, expect, it } from 'vitest';
import {
  HASH_BITS,
  SIMILAR_ENOUGH_TO_ASK,
  hammingDistance,
  hashDcImage,
  looksLikeTheSamePage,
  mostSimilarPage,
  pageHash,
} from '../src/phash';
import { decodeDc } from '../src/dcscan';

const page = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/pages/${name}`, import.meta.url))));

const hash = (name: string): string => {
  const value = pageHash(page(name));
  expect(value, `${name} produced no hash`).not.toBeNull();
  return value!;
};

const SAME = ['d00_1.jpg', 'd00_2.jpg', 'd00_3.jpg', 'd00_4.jpg'];
const OTHERS = ['d05_1.jpg', 'd05_2.jpg', 'd09_1.jpg', 'd11_1.jpg'];

suite('recognising a page photographed twice', () => {
  it('matches every pair of captures of the same page', () => {
    for (const a of SAME) {
      for (const b of SAME) {
        if (a >= b) continue;
        const distance = hammingDistance(hash(a), hash(b));
        expect(distance, `${a} vs ${b}: ${distance} bits`).toBeLessThanOrEqual(
          SIMILAR_ENOUGH_TO_ASK,
        );
        expect(looksLikeTheSamePage(hash(a), hash(b))).toBe(true);
      }
    }
  });

  it('never mistakes one document for another', () => {
    const all = [...SAME, ...OTHERS];
    for (const a of all) {
      for (const b of all) {
        if (a >= b) continue;
        // Same document iff the fixtures share a prefix.
        if (a.slice(0, 3) === b.slice(0, 3)) continue;
        const distance = hammingDistance(hash(a), hash(b));
        expect(distance, `${a} vs ${b}: only ${distance} bits apart`).toBeGreaterThan(
          SIMILAR_ENOUGH_TO_ASK,
        );
      }
    }
  });

  it('leaves real room between the two, rather than scraping past the threshold', () => {
    let worstSame = 0;
    let closestDifferent = HASH_BITS;
    const all = [...SAME, ...OTHERS];
    for (const a of all) {
      for (const b of all) {
        if (a >= b) continue;
        const distance = hammingDistance(hash(a), hash(b));
        if (a.slice(0, 3) === b.slice(0, 3)) worstSame = Math.max(worstSame, distance);
        else closestDifferent = Math.min(closestDifferent, distance);
      }
    }
    // A gap, not a hairline. If a change to the descriptor narrows this, the
    // threshold stops being a decision and starts being a coincidence.
    expect(
      closestDifferent,
      `same <= ${worstSame}, different >= ${closestDifferent}`,
    ).toBeGreaterThan(worstSame * 1.5);
  });
});

suite('having no opinion', () => {
  it('says nothing about a progressive JPEG rather than guessing', () => {
    const progressive = new Uint8Array(
      readFileSync(fileURLToPath(new URL('./fixtures/detail-progressive.jpg', import.meta.url))),
    );
    expect(decodeDc(progressive)).toBeNull();
    expect(pageHash(progressive)).toBeNull();
  });

  /** An image built to order, so the guards can be aimed at directly. */
  const image = (across: number, down: number, at: (x: number, y: number) => number) => {
    const luma = new Uint8Array(across * down);
    for (let y = 0; y < down; y++) for (let x = 0; x < across; x++) luma[y * across + x] = at(x, y);
    return { luma, across, down, width: across * 8, height: down * 8 };
  };

  it('says nothing about a blank page', () => {
    // The one false positive guaranteed to happen otherwise: every blank sheet would
    // hash identically, so the second blank page anyone scans gets accused of being
    // the first. Paper with a little sensor noise on it is still blank paper.
    expect(hashDcImage(image(40, 52, () => 240))).toBeNull();
    expect(hashDcImage(image(40, 52, (x, y) => 238 + ((x * 7 + y * 3) % 5)))).toBeNull();
  });

  it('says nothing about ink with no layout', () => {
    // Plenty of contrast, and every cell holds the same amount of ink. Which cells
    // land above the average is then decided by rounding, so two unrelated images
    // like this would match each other.
    const striped = image(64, 64, (_x, y) => (y % 4 === 0 ? 40 : 236));
    expect(striped.luma.some((v) => v < 128)).toBe(true);
    expect(hashDcImage(striped)).toBeNull();
  });

  it('does hash a page that has a layout, so the guards are not simply refusing', () => {
    // Margins and a block of text: the ordinary case the guards must let through.
    const document = image(40, 52, (x, y) =>
      x > 4 && x < 34 && y > 6 && y < 30 && y % 3 !== 0 ? 40 : 236,
    );
    expect(hashDcImage(document)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says nothing about an image too small to reduce', () => {
    expect(hashDcImage(image(8, 8, () => 40))).toBeNull();
  });

  it('says nothing about bytes that are not a JPEG', () => {
    expect(pageHash(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(pageHash(new Uint8Array(0))).toBeNull();
  });
});

suite('the hash itself', () => {
  it('is 256 bits of lowercase hex', () => {
    const value = hash('d00_1.jpg');
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(HASH_BITS).toBe(256);
  });

  it('is stable for the same bytes', () => {
    expect(hash('d00_1.jpg')).toBe(hash('d00_1.jpg'));
  });

  it('treats a length mismatch as maximally different', () => {
    expect(hammingDistance('abcd', 'abcdef')).toBe(HASH_BITS);
  });
});

suite('choosing which earlier capture to mention', () => {
  const of = (name: string) => ({ pageHash: hash(name), value: name });

  it('picks the closest match among earlier captures', () => {
    const found = mostSimilarPage(hash('d00_1.jpg'), [
      of('d05_1.jpg'),
      of('d00_3.jpg'),
      of('d09_1.jpg'),
    ]);
    expect(found?.value).toBe('d00_3.jpg');
    expect(found?.distance).toBeLessThanOrEqual(SIMILAR_ENOUGH_TO_ASK);
  });

  it('says nothing when none is close enough', () => {
    expect(mostSimilarPage(hash('d00_1.jpg'), [of('d05_1.jpg'), of('d11_1.jpg')])).toBeNull();
    expect(mostSimilarPage(hash('d00_1.jpg'), [])).toBeNull();
  });

  it('skips captures with no hash instead of counting them as different', () => {
    // Documents from before this existed, and images we could not read. Treating a
    // missing hash as "not a match" is right; treating it as evidence would not be.
    const found = mostSimilarPage(hash('d00_1.jpg'), [
      { pageHash: null, value: 'older' },
      of('d00_2.jpg'),
    ]);
    expect(found?.value).toBe('d00_2.jpg');
  });

  it('prefers the nearer of two matches', () => {
    const near = mostSimilarPage(hash('d00_1.jpg'), [of('d00_2.jpg'), of('d00_3.jpg')]);
    const a = hammingDistance(hash('d00_1.jpg'), hash('d00_2.jpg'));
    const b = hammingDistance(hash('d00_1.jpg'), hash('d00_3.jpg'));
    expect(near?.distance).toBe(Math.min(a, b));
  });
});
