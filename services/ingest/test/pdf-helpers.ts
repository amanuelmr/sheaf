import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A PDF whose pages say their own names, so the order can be read back. */
export async function labelled(...names: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const name of names) {
    const page = doc.addPage([200, 200]);
    page.drawText(name, { x: 20, y: 100, font, size: 12 });
    doc.setTitle('x');
    page.node.set(page.node.context.obj('SheafName'), page.node.context.obj(name));
  }
  return doc.save();
}

export async function names(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc
    .getPages()
    .map((page) => String(page.node.get(page.node.context.obj('SheafName'))).slice(1));
}

export async function turns(bytes: Uint8Array): Promise<number[]> {
  return (await PDFDocument.load(bytes)).getPages().map((page) => page.getRotation().angle);
}

import { deflateSync, crc32 } from 'node:zlib';
import { BarcodeFormat, DataMatrixWriter, QRCodeWriter } from '@zxing/library';
import jpeg from 'jpeg-js';

/** A barcode as grey pixels, with a white margin, each module `scale` pixels wide. */
function barcodePixels(text: string, format: BarcodeFormat, scale = 3) {
  const matrix =
    format === BarcodeFormat.QR_CODE
      ? new QRCodeWriter().encode(text, format, 40, 40, new Map())
      : new DataMatrixWriter().encode(text, format, 24, 24, new Map());
  const margin = 20;
  const w = matrix.getWidth() * scale + margin * 2;
  const h = matrix.getHeight() * scale + margin * 2;
  const grey = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < matrix.getHeight() * scale; y++) {
    for (let x = 0; x < matrix.getWidth() * scale; x++) {
      if (matrix.get(Math.floor(x / scale), Math.floor(y / scale)))
        grey[(y + margin) * w + x + margin] = 0;
    }
  }
  return { w, h, grey };
}

function jpegOf(text: string): Uint8Array {
  const { w, h, grey } = barcodePixels(text, BarcodeFormat.DATA_MATRIX, 6);
  const rgba = new Uint8Array(w * h * 4);
  grey.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
  return new Uint8Array(jpeg.encode({ data: rgba, width: w, height: h }, 95).data);
}

function pngOf(text: string): Uint8Array {
  const { w, h, grey } = barcodePixels(text, BarcodeFormat.QR_CODE, 4);
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w + 1)] = 0;
    Buffer.from(grey.subarray(y * w, (y + 1) * w)).copy(rows, y * (w + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/**
 * A scanned-looking PDF: each page is a picture, as a scanner makes. A page given as
 * `{ matrix }` pictures that barcode as a JPEG, `{ qr }` as a PNG, a string is a
 * plain page that says its name.
 */
export async function scanned(
  ...pages: Array<string | { matrix: string } | { qr: string }>
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const spec of pages) {
    const page = doc.addPage([400, 400]);
    const name = typeof spec === 'string' ? spec : 'matrix' in spec ? spec.matrix : spec.qr;
    page.node.set(page.node.context.obj('SheafName'), page.node.context.obj(name));
    if (typeof spec === 'string') continue;
    const image =
      'matrix' in spec
        ? await doc.embedJpg(jpegOf(spec.matrix))
        : await doc.embedPng(pngOf(spec.qr));
    page.drawImage(image, { x: 20, y: 20, width: image.width, height: image.height });
  }
  return doc.save();
}
