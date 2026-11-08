import { inflateSync } from 'node:zlib';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from '@zxing/library';
import jpeg from 'jpeg-js';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  type PDFObject,
} from 'pdf-lib';

/** A grey image: one byte of brightness per pixel. */
interface Grey {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/** Larger than any scan, so a crafted image cannot make the server allocate gigabytes. */
const MAX_PIXELS = 50_000_000;

const FORMATS = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.EAN_13,
  BarcodeFormat.ITF,
];

/**
 * The barcodes on each page of a scanned PDF, page by page.
 *
 * Scans are pictures: each page carries its image, and that image is read. A JPEG
 * (DCTDecode), a deflated image (with or without PNG predictors) and an
 * uncompressed one are understood; a page whose barcode is drawn rather than
 * pictured, or pictured in a format not listed, reads as having none.
 */
export async function readBarcodes(bytes: Uint8Array): Promise<string[][]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, FORMATS],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  reader.setHints(hints);

  return document.getPages().map((page) => {
    const found = new Set<string>();
    for (const image of pageImages(page.node.Resources(), document)) {
      const grey = decode(image);
      if (grey === null) continue;
      const text = scan(reader, grey);
      if (text !== null) found.add(text.trim());
    }
    return [...found];
  });
}

/** Image streams the page draws, including those inside its form XObjects. */
function pageImages(
  resources: PDFDict | undefined,
  document: PDFDocument,
  depth = 0,
): PDFRawStream[] {
  if (resources === undefined || depth > 3) return [];
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (xobjects === undefined) return [];
  const images: PDFRawStream[] = [];
  for (const [, ref] of xobjects.entries()) {
    const stream = document.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Image')) images.push(stream);
    if (subtype === PDFName.of('Form')) {
      const inner = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      images.push(...pageImages(inner, document, depth + 1));
    }
  }
  return images;
}

function number(dict: PDFDict, key: string): number | null {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function filters(dict: PDFDict): string[] {
  const filter: PDFObject | undefined = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return [filter.asString()];
  if (filter instanceof PDFArray) {
    return filter.asArray().map((f) => (f instanceof PDFName ? f.asString() : ''));
  }
  return [];
}

/** The image as grey pixels, or null for one this does not understand. */
function decode(stream: PDFRawStream): Grey | null {
  const dict = stream.dict;
  const width = number(dict, 'Width');
  const height = number(dict, 'Height');
  if (width === null || height === null || width * height > MAX_PIXELS || width < 1 || height < 1) {
    return null;
  }
  const chain = filters(dict);
  try {
    if (chain.length === 1 && chain[0] === '/DCTDecode') {
      const image = jpeg.decode(stream.contents, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 1024,
      });
      return fromRgba(image.width, image.height, image.data);
    }
    if (chain.length > 1 || (chain.length === 1 && chain[0] !== '/FlateDecode')) return null;
    const bits = number(dict, 'BitsPerComponent') ?? 8;
    const space = dict.lookup(PDFName.of('ColorSpace'));
    const components =
      space === PDFName.of('DeviceGray') ? 1 : space === PDFName.of('DeviceRGB') ? 3 : null;
    if (components === null || (bits !== 8 && !(bits === 1 && components === 1))) return null;
    let raw: Uint8Array = chain.length === 0 ? stream.contents : inflateSync(stream.contents);
    const params = dict.lookupMaybe(PDFName.of('DecodeParms'), PDFDict);
    const predictor = params === undefined ? 1 : (number(params, 'Predictor') ?? 1);
    const rowBytes = Math.ceil((width * components * bits) / 8);
    if (predictor >= 10) raw = unpredict(raw, rowBytes, Math.max(1, (components * bits) / 8));
    if (raw.length < rowBytes * height) return null;
    const pixels = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * rowBytes;
        if (bits === 1) {
          // 1 is white unless a Decode array says otherwise; scans use the default.
          pixels[y * width + x] = (raw[at + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
        } else if (components === 1) {
          pixels[y * width + x] = raw[at + x]!;
        } else {
          const i = at + x * 3;
          pixels[y * width + x] = (raw[i]! * 299 + raw[i + 1]! * 587 + raw[i + 2]! * 114) / 1000;
        }
      }
    }
    return { width, height, pixels };
  } catch {
    return null;
  }
}

function fromRgba(width: number, height: number, data: Uint8Array): Grey {
  const pixels = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    pixels[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000;
  }
  return { width, height, pixels };
}

/** Undo PNG row filters (PDF predictors 10 to 15): each row starts with its filter type. */
function unpredict(data: Uint8Array, rowBytes: number, pixelBytes: number): Uint8Array {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]!;
    const row = data.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1));
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= pixelBytes ? out[r * rowBytes + i - pixelBytes]! : 0;
      const up = r > 0 ? out[(r - 1) * rowBytes + i]! : 0;
      const upLeft = r > 0 && i >= pixelBytes ? out[(r - 1) * rowBytes + i - pixelBytes]! : 0;
      let value = row[i]!;
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[r * rowBytes + i] = value & 0xff;
    }
  }
  return out;
}

function scan(reader: MultiFormatReader, grey: Grey): string | null {
  try {
    const source = new RGBLuminanceSource(grey.pixels, grey.width, grey.height);
    return reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source))).getText();
  } catch (error) {
    if (error instanceof NotFoundException) return null;
    return null;
  } finally {
    reader.reset();
  }
}

/** What the barcodes on a document's pages ask for. */
export interface BarcodePlan {
  /** Parts to split into, as pages from 1, separator pages left out; null when there is no separator. */
  readonly parts: number[][] | null;
  /** The first serial number found, when there is no split. */
  readonly asn: number | null;
}

export function plan(
  pages: readonly (readonly string[])[],
  separator: string,
  asnPrefix: string,
): BarcodePlan {
  const isSeparator = (page: readonly string[]) => page.some((text) => text === separator);
  const asnPattern = new RegExp(
    `^${asnPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*0*(\\d{1,10})$`,
    'i',
  );
  let asn: number | null = null;
  for (const page of pages) {
    for (const text of page) {
      const match = asnPattern.exec(text);
      if (match !== null && asn === null) asn = Number(match[1]);
    }
  }
  if (!pages.some(isSeparator))
    return { parts: null, asn: asn !== null && asn <= 2_147_483_647 ? asn : null };
  const parts: number[][] = [[]];
  pages.forEach((page, i) => {
    if (isSeparator(page)) parts.push([]);
    else parts.at(-1)!.push(i + 1);
  });
  return { parts: parts.filter((part) => part.length > 0), asn: null };
}
