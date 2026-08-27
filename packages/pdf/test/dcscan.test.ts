/**
 * The decoder is checked against libjpeg's own, which is the only assertion here
 * that does not depend on my understanding of the format being right. Where `djpeg`
 * is unavailable the golden values below still catch drift -- they were produced by
 * this decoder, but only after it had agreed with libjpeg to within a fraction of a
 * grey level.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe as suite, expect, it } from 'vitest';
import { decodeDc } from '../src/dcscan';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const path = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const hasDjpeg = (() => {
  try {
    execFileSync('djpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** libjpeg's greyscale decode of the same file, as a plain PGM. */
function reference(name: string): { width: number; height: number; data: Uint8Array } {
  const out = execFileSync('djpeg', ['-grayscale', '-pnm', path(name)], { maxBuffer: 1 << 28 });
  let at = 2; // past "P5"
  const number = (): number => {
    while (out[at] === 0x20 || out[at] === 0x0a || out[at] === 0x09 || out[at] === 0x0d) at += 1;
    let value = 0;
    while (out[at]! >= 0x30 && out[at]! <= 0x39) {
      value = value * 10 + (out[at]! - 0x30);
      at += 1;
    }
    return value;
  };
  const width = number();
  const height = number();
  number();
  at += 1;
  return { width, height, data: new Uint8Array(out.subarray(at)) };
}

/** Mean absolute difference, in grey levels, between our blocks and libjpeg's. */
function disagreement(name: string): number {
  const mine = decodeDc(fixture(name))!;
  const truth = reference(name);
  let total = 0;
  let blocks = 0;
  for (let by = 0; by < mine.down; by++) {
    for (let bx = 0; bx < mine.across; bx++) {
      let sum = 0;
      let pixels = 0;
      for (let y = by * 8; y < Math.min(by * 8 + 8, truth.height); y++) {
        for (let x = bx * 8; x < Math.min(bx * 8 + 8, truth.width); x++) {
          sum += truth.data[y * truth.width + x]!;
          pixels += 1;
        }
      }
      if (pixels === 0) continue;
      total += Math.abs(sum / pixels - mine.luma[by * mine.across + bx]!);
      blocks += 1;
    }
  }
  return total / blocks;
}

suite('against libjpeg', () => {
  it.skipIf(!hasDjpeg)('agrees on a subsampled colour photograph', () => {
    expect(disagreement('detail-color.jpg')).toBeLessThan(1.5);
  });

  it.skipIf(!hasDjpeg)('agrees on a file with restart markers', () => {
    // Restart intervals reset the DC predictors mid-scan. Getting this wrong shifts
    // the brightness of everything after the first restart, which is why it is here.
    expect(disagreement('detail-restart.jpg')).toBeLessThan(1.5);
  });

  it.skipIf(!hasDjpeg)('agrees on a greyscale photograph', () => {
    expect(disagreement('detail-gray.jpg')).toBeLessThan(1.5);
  });
});

suite('reading the frame', () => {
  it('reports the size the encoder wrote, and one block per 8 pixels', () => {
    const image = decodeDc(fixture('detail-color.jpg'))!;
    expect([image.width, image.height]).toEqual([203, 151]);
    expect([image.across, image.down]).toEqual([26, 19]);
    expect(image.luma).toHaveLength(26 * 19);
  });

  it('produces the same bytes every time', () => {
    const a = decodeDc(fixture('detail-color.jpg'))!;
    const b = decodeDc(fixture('detail-color.jpg'))!;
    expect(Array.from(b.luma)).toEqual(Array.from(a.luma));
  });

  it('matches the values it agreed with libjpeg on', () => {
    const image = decodeDc(fixture('detail-gray.jpg'))!;
    let checksum = 0;
    for (const value of image.luma) checksum = (checksum * 31 + value) % 1_000_003;
    expect({ checksum, first: Array.from(image.luma.subarray(0, 6)) }).toMatchInlineSnapshot(`
      {
        "checksum": 393214,
        "first": [
          141,
          124,
          116,
          149,
          90,
          169,
        ],
      }
    `);
  });
});

suite('declining to guess', () => {
  it('returns null for a progressive JPEG', () => {
    expect(decodeDc(fixture('detail-progressive.jpg'))).toBeNull();
  });

  it('returns null for bytes that are not a JPEG', () => {
    expect(decodeDc(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull();
    expect(decodeDc(new Uint8Array(0))).toBeNull();
    expect(decodeDc(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('returns null for a truncated file rather than half a picture', () => {
    const whole = fixture('detail-gray.jpg');
    expect(decodeDc(whole.slice(0, Math.floor(whole.length / 2)))).toBeNull();
  });
});
