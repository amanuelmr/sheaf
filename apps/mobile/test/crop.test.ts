import { describe as suite, expect, it } from 'vitest';
import {
  clamp,
  fitted,
  fullSelection,
  isMeaningfulCrop,
  rotatedSize,
  toImageRect,
  turn,
} from '../src/lib/crop';

// A portrait photo shown in a landscape-ish container: letterboxed on both sides,
// which is exactly where naive coordinate maths goes wrong.
const IMAGE = { width: 3024, height: 4032 };
const CONTAINER = { width: 390, height: 600 };

suite('rotation', () => {
  it('swaps the sides on a quarter turn, and not otherwise', () => {
    expect(rotatedSize(IMAGE, 0)).toEqual(IMAGE);
    expect(rotatedSize(IMAGE, 180)).toEqual(IMAGE);
    expect(rotatedSize(IMAGE, 90)).toEqual({ width: 4032, height: 3024 });
    expect(rotatedSize(IMAGE, 270)).toEqual({ width: 4032, height: 3024 });
  });

  it('turns without ever leaving the four legal values', () => {
    expect(turn(0, 1)).toBe(90);
    expect(turn(270, 1)).toBe(0);
    expect(turn(0, -1)).toBe(270);
    expect(turn(90, -1)).toBe(0);
    let r = 0 as ReturnType<typeof turn>;
    for (let i = 0; i < 9; i++) r = turn(r, 1);
    expect(r).toBe(90);
  });
});

suite('fitting an image into a container', () => {
  it('centres and letterboxes, as `contain` does', () => {
    const fit = fitted(IMAGE, CONTAINER);
    // Width binds: 390/3024 is smaller than 600/4032, so the bars are top and
    // bottom. Guessing which side binds is exactly the mistake this maths exists
    // to avoid, and the first version of this test guessed wrong.
    expect(fit.scale).toBeCloseTo(390 / 3024, 6);
    expect(fit.size.width).toBeCloseTo(390, 4);
    expect(fit.offsetX).toBeCloseTo(0, 4);
    expect(fit.offsetY).toBeGreaterThan(0);
  });

  it('survives a container that has not been measured yet', () => {
    // First render reports zero, and dividing by it would poison every later crop.
    expect(fitted(IMAGE, { width: 0, height: 0 }).scale).toBe(1);
    expect(fitted({ width: 0, height: 0 }, CONTAINER).scale).toBe(1);
  });
});

suite('mapping a selection onto the image', () => {
  it('maps the whole visible image back to the whole image', () => {
    const rect = toImageRect(fullSelection(CONTAINER, IMAGE, 0), CONTAINER, IMAGE, 0);
    expect(rect).toEqual({ x: 0, y: 0, width: 3024, height: 4032 });
  });

  it('maps a half-height selection to half the image', () => {
    const full = fullSelection(CONTAINER, IMAGE, 0);
    const half = { ...full, height: full.height / 2 };
    const rect = toImageRect(half, CONTAINER, IMAGE, 0);
    expect(rect.height).toBe(2016);
    expect(rect.width).toBe(3024);
    expect(rect.y).toBe(0);
  });

  it('accounts for the letterbox rather than assuming the image starts at zero', () => {
    // The image is inset vertically here, so a selection covering the whole
    // container reaches above and below the picture. Ignoring the offset would
    // crop from the wrong part of the page; clamping brings it back to the image.
    const fit = fitted(IMAGE, CONTAINER);
    expect(fit.offsetY).toBeGreaterThan(10);

    const rect = toImageRect(
      { x: 0, y: 0, width: CONTAINER.width, height: CONTAINER.height },
      CONTAINER,
      IMAGE,
      0,
    );
    expect(rect).toEqual({ x: 0, y: 0, width: 3024, height: 4032 });

    // And a selection sitting entirely inside the top bar maps to the very top of
    // the image rather than to a negative coordinate.
    const inBar = toImageRect({ x: 0, y: 0, width: 390, height: 5 }, CONTAINER, IMAGE, 0);
    expect(inBar.y).toBe(0);
    expect(inBar.height).toBeGreaterThan(0);
  });

  it('crops against the rotated image, because rotation happens first', () => {
    // The receipt case: a portrait photo turned sideways to be read.
    const full = fullSelection(CONTAINER, IMAGE, 90);
    const rect = toImageRect(full, CONTAINER, IMAGE, 90);
    expect(rect).toEqual({ x: 0, y: 0, width: 4032, height: 3024 });
  });
});

suite('clamping', () => {
  it('keeps a crop inside the image', () => {
    // The native manipulator rejects an out-of-bounds crop rather than trimming it,
    // so a drag past the corner has to be brought back here.
    expect(clamp({ x: -50, y: -50, width: 5000, height: 5000 }, IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 3024,
      height: 4032,
    });
    expect(clamp({ x: 3000, y: 4000, width: 500, height: 500 }, IMAGE)).toEqual({
      x: 2524,
      y: 3532,
      width: 500,
      height: 500,
    });
  });

  it('never produces a zero-sized crop', () => {
    const rect = clamp({ x: 10, y: 10, width: 0, height: -5 }, IMAGE);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('returns whole numbers, which is what the manipulator expects', () => {
    const rect = clamp({ x: 10.4, y: 10.6, width: 100.5, height: 200.5 }, IMAGE);
    for (const v of Object.values(rect)) expect(Number.isInteger(v)).toBe(true);
  });
});

suite('deciding whether to crop at all', () => {
  it('skips a crop that is really the whole page', () => {
    // Doing a no-op crop would re-encode the image for nothing, losing quality on
    // the way to a file that is meant to be identical.
    expect(isMeaningfulCrop({ x: 0, y: 0, ...IMAGE }, IMAGE)).toBe(false);
    expect(isMeaningfulCrop({ x: 0, y: 0, width: 3020, height: 4030 }, IMAGE)).toBe(false);
  });

  it('takes a genuine crop seriously', () => {
    expect(isMeaningfulCrop({ x: 0, y: 0, width: 1500, height: 4032 }, IMAGE)).toBe(true);
  });
});
