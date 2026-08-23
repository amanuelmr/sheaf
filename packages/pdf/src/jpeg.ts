/**
 * Just enough JPEG parsing to embed a photo in a PDF.
 *
 * A JPEG can be placed into a PDF as a `DCTDecode` image without re-encoding, so
 * the camera's own bytes end up in the file untouched — no decode, no recompress,
 * no quality loss, and nothing for a codec version to change between runs. All we
 * need from the file is what the PDF has to declare about it.
 */

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  /** 1 = greyscale, 3 = YCbCr, 4 = CMYK. Decides the PDF colour space. */
  readonly components: number;
  /** True for a progressive JPEG, which some PDF readers render poorly. */
  readonly progressive: boolean;
}

/** Start-of-frame markers, which carry the dimensions. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const PROGRESSIVE_SOF = new Set([0xc2, 0xc6, 0xca, 0xce]);
/** Markers that stand alone, with no length field following them. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i += 1; // resynchronise through padding or entropy-coded data
      continue;
    }
    // Runs of 0xFF are legal fill bytes before a marker.
    let marker = bytes[i + 1]!;
    let cursor = i + 2;
    while (marker === 0xff && cursor < bytes.length) {
      marker = bytes[cursor]!;
      cursor += 1;
    }

    if (STANDALONE.has(marker)) {
      i = cursor;
      continue;
    }
    // Start of scan: the frame header is behind us, so there is nothing more to find.
    if (marker === 0xda) return null;

    if (cursor + 1 >= bytes.length) return null;
    const length = (bytes[cursor]! << 8) | bytes[cursor + 1]!;
    if (length < 2) return null;

    if (SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2) components(1)
      if (cursor + 7 >= bytes.length) return null;
      const height = (bytes[cursor + 3]! << 8) | bytes[cursor + 4]!;
      const width = (bytes[cursor + 5]! << 8) | bytes[cursor + 6]!;
      const components = bytes[cursor + 7]!;
      if (width === 0 || height === 0 || components === 0) return null;
      return { width, height, components, progressive: PROGRESSIVE_SOF.has(marker) };
    }

    i = cursor + length;
  }
  return null;
}
