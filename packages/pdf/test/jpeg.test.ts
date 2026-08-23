import { describe as suite, expect, it } from 'vitest';
import { readJpegInfo } from '../src/jpeg';
import { jpeg } from './fixtures';

suite('readJpegInfo', () => {
  it('reads dimensions past the APP0 segment', () => {
    expect(readJpegInfo(jpeg({ width: 1700, height: 2200 }))).toEqual({
      width: 1700,
      height: 2200,
      components: 3,
      progressive: false,
    });
  });

  it('reads a file with no APP0 at all', () => {
    expect(readJpegInfo(jpeg({ width: 8, height: 12, withApp0: false }))?.width).toBe(8);
  });

  it('reports the colour space so the PDF can declare it', () => {
    expect(readJpegInfo(jpeg({ width: 4, height: 4, components: 1 }))?.components).toBe(1);
    expect(readJpegInfo(jpeg({ width: 4, height: 4, components: 4 }))?.components).toBe(4);
  });

  it('flags progressive files, which some PDF readers handle badly', () => {
    expect(readJpegInfo(jpeg({ width: 4, height: 4, progressive: true }))?.progressive).toBe(true);
    expect(readJpegInfo(jpeg({ width: 4, height: 4 }))?.progressive).toBe(false);
  });

  it('tolerates fill bytes before a marker', () => {
    const base = jpeg({ width: 100, height: 200, withApp0: false });
    const padded = new Uint8Array([...base.slice(0, 2), 0xff, 0xff, 0xff, ...base.slice(2)]);
    expect(readJpegInfo(padded)?.height).toBe(200);
  });

  it('refuses anything that is not a JPEG', () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0xff]),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG
      new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF
      new Uint8Array([0xff, 0xd8]), // truncated to the marker
    ]) {
      expect(readJpegInfo(bytes)).toBeNull();
    }
  });

  it('refuses a frame header with impossible dimensions', () => {
    expect(readJpegInfo(jpeg({ width: 0, height: 10 }))).toBeNull();
    expect(readJpegInfo(jpeg({ width: 10, height: 0 }))).toBeNull();
  });

  it('gives up rather than guessing when the header is truncated', () => {
    const full = jpeg({ width: 640, height: 480 });
    expect(readJpegInfo(full.slice(0, full.indexOf(0xc0) + 4))).toBeNull();
  });
});
