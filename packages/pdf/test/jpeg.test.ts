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

suite('malformed and hostile input', () => {
  /**
   * This parser is the only place untrusted bytes are interpreted, and it was the
   * weakest-covered file in the repo. A camera roll can contain anything, and a
   * parser that loops or reads past the end here would take the app down at the
   * exact moment the user is trying to save something.
   */
  it('never runs off the end, whatever the bytes are', () => {
    const nasty: Uint8Array[] = [
      new Uint8Array([0xff, 0xd8, 0xff]), // marker with no payload
      new Uint8Array([0xff, 0xd8, 0xff, 0xc0]), // SOF with no length
      new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00]), // length half written
      new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11]), // length but no frame
      new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x00]), // length below the minimum
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), // segment longer than the file
      new Uint8Array([0xff, 0xd8, ...Array(64).fill(0xff)]), // nothing but fill bytes
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), // scan, no frame
    ];
    for (const bytes of nasty) {
      expect(readJpegInfo(bytes), Array.from(bytes.slice(0, 8)).join(',')).toBeNull();
    }
  });

  it('resynchronises through junk rather than giving up at the first odd byte', () => {
    // Entropy-coded data and padding both look like junk between markers.
    const real = jpeg({ width: 320, height: 240, withApp0: false });
    const withJunk = new Uint8Array([
      ...real.slice(0, 2),
      0x00,
      0x11,
      0x22,
      0x33, // bytes that are not a marker
      ...real.slice(2),
    ]);
    expect(readJpegInfo(withJunk)).toEqual({
      width: 320,
      height: 240,
      components: 3,
      progressive: false,
    });
  });

  it('skips restart markers and other standalone markers', () => {
    const real = jpeg({ width: 64, height: 48, withApp0: false });
    const withRestarts = new Uint8Array([
      ...real.slice(0, 2),
      0xff,
      0xd0, // RST0 — standalone, no length
      0xff,
      0x01, // TEM — standalone
      ...real.slice(2),
    ]);
    expect(readJpegInfo(withRestarts)?.width).toBe(64);
  });

  it('stops at start-of-scan instead of misreading compressed data as a header', () => {
    // A file whose frame header is missing but which has a scan: the answer is
    // "unknown", not a dimension invented from pixel data.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0,
      0x12, 0x34, 0x56, 0xff, 0xd9,
    ]);
    expect(readJpegInfo(bytes)).toBeNull();
  });

  it('terminates on every truncation of a real file', () => {
    // The cheap way to be sure there is no unbounded loop or out-of-range read.
    const real = jpeg({ width: 800, height: 600 });
    for (let cut = 0; cut <= real.length; cut++) {
      expect(() => readJpegInfo(real.slice(0, cut))).not.toThrow();
    }
  });
});
