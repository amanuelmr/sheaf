import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setTextRenderingMode,
} from 'pdf-lib';

/** One page of the result: which page of the original (from 1), and how far to turn it. */
export interface PageSpec {
  readonly page: number;
  /** Clockwise, added to whatever turn the page already has. */
  readonly rotate?: 0 | 90 | 180 | 270;
}

async function open(bytes: Uint8Array): Promise<PDFDocument> {
  // Scans from phones and scanners are rarely encrypted; one that is cannot be
  // rewritten without its password, and is refused rather than half-edited.
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await open(bytes)).getPageCount();
}

/**
 * A new PDF of the pages listed, in that order, each turned as asked: rotating,
 * removing and reordering pages are all this one operation. Throws `RangeError` for
 * a page the document does not have.
 */
export async function editPages(
  bytes: Uint8Array,
  pages: readonly PageSpec[],
): Promise<Uint8Array> {
  const source = await open(bytes);
  const count = source.getPageCount();
  for (const spec of pages) {
    if (!Number.isInteger(spec.page) || spec.page < 1 || spec.page > count) {
      throw new RangeError(
        `there is no page ${String(spec.page)}; the document has ${String(count)}`,
      );
    }
  }
  if (pages.length === 0) throw new RangeError('a document needs at least one page');
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((spec) => spec.page - 1),
  );
  copied.forEach((page, i) => {
    const turn = pages[i]?.rotate ?? 0;
    if (turn !== 0) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    out.addPage(page);
  });
  return out.save();
}

/** One PDF per part, each part a list of pages from 1. */
export async function splitPdf(
  bytes: Uint8Array,
  parts: readonly (readonly number[])[],
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = [];
  for (const part of parts)
    results.push(
      await editPages(
        bytes,
        part.map((page) => ({ page })),
      ),
    );
  return results;
}

/** The documents' pages one after another, in the order given. */
export async function mergePdfs(documents: readonly Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of documents) {
    const source = await open(bytes);
    const pages = await out.copyPages(source, source.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}

/**
 * Fronts and backs scanned as two passes of a one-sided feeder, put back in
 * reading order: front 1, back 1, front 2... The backs come out of the feeder last
 * page first, so they are read in reverse. Both passes must have the same number
 * of pages; anything else is not a double-sided scan.
 */
export async function collate(fronts: Uint8Array, backs: Uint8Array): Promise<Uint8Array> {
  const [a, b] = [await open(fronts), await open(backs)];
  const count = a.getPageCount();
  if (b.getPageCount() !== count) {
    throw new RangeError(
      `the fronts have ${String(count)} pages and the backs ${String(b.getPageCount())}`,
    );
  }
  const out = await PDFDocument.create();
  const frontPages = await out.copyPages(a, a.getPageIndices());
  const backPages = await out.copyPages(b, b.getPageIndices().reverse());
  for (let i = 0; i < count; i++) {
    out.addPage(frontPages[i]);
    out.addPage(backPages[i]);
  }
  return out.save();
}

/** A point as the page is shown, turned back into the page's own coordinates. */
export function unrotate(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): { readonly x: number; readonly y: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: width - y, y: x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: y, y: height - x };
    default:
      return { x, y };
  }
}

export interface Stamp {
  readonly lines: readonly string[];
  readonly position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  readonly colour: readonly [number, number, number];
  readonly allPages: boolean;
}

/**
 * Draws a stamp: the lines in a box near a corner, upright as the page is shown,
 * however the page is turned. Nothing already on the page is changed.
 */
export async function stampPdf(bytes: Uint8Array, stamp: Stamp): Promise<Uint8Array> {
  const document = await open(bytes);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  const colour = rgb(...stamp.colour);
  const pages = document.getPages();
  for (const page of stamp.allPages ? pages : pages.slice(0, 1)) {
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    const turned = rotation % 180 !== 0;
    const [shownWidth, shownHeight] = turned ? [height, width] : [width, height];
    // Sized to the page, so a receipt and a poster both get a stamp that reads.
    const size = Math.max(8, Math.min(18, Math.min(shownWidth, shownHeight) / 30));
    const padding = size * 0.6;
    const gap = size * 0.3;
    const boxWidth =
      Math.max(...stamp.lines.map((line) => font.widthOfTextAtSize(line, size))) + padding * 2;
    const boxHeight = stamp.lines.length * size + (stamp.lines.length - 1) * gap + padding * 2;
    const margin = Math.min(shownWidth, shownHeight) * 0.04;
    const left = stamp.position.endsWith('left') ? margin : shownWidth - margin - boxWidth;
    const bottom = stamp.position.startsWith('bottom') ? margin : shownHeight - margin - boxHeight;
    const corner = unrotate(left, bottom, width, height, rotation);
    page.drawRectangle({
      x: corner.x,
      y: corner.y,
      width: boxWidth,
      height: boxHeight,
      borderColor: colour,
      borderWidth: Math.max(1, size / 8),
      rotate: degrees(rotation),
      opacity: 0,
      borderOpacity: 0.9,
    });
    stamp.lines.forEach((line, i) => {
      const lineWidth = font.widthOfTextAtSize(line, size);
      const baseline = bottom + boxHeight - padding - (i + 1) * size - i * gap + size * 0.2;
      const at = unrotate(left + (boxWidth - lineWidth) / 2, baseline, width, height, rotation);
      page.drawText(line, {
        x: at.x,
        y: at.y,
        size,
        font,
        color: colour,
        rotate: degrees(rotation),
        opacity: 0.9,
      });
    });
  }
  return document.save();
}

/**
 * The PDF with recognised text laid invisibly over its pages, so a viewer, Spotlight
 * or a file browser finds a scan by its words. The text is spread over the pages in
 * order; where each word falls on its page is not known, so a found word is on the
 * right page or near it, not under the right spot. Characters the built-in font
 * cannot carry become spaces.
 */
export async function searchablePdf(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const document = await open(bytes);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const known = new Set(font.getCharacterSet());
  const clean = [...text.normalize('NFC')]
    .map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)!) ? ch : ' '))
    .join('');
  const lines = clean
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const pages = document.getPages();
  if (lines.length === 0 || pages.length === 0) return bytes;
  const perPage = Math.ceil(lines.length / pages.length);
  pages.forEach((page, p) => {
    const chunk = lines.slice(p * perPage, (p + 1) * perPage);
    if (chunk.length === 0) return;
    const { width, height } = page.getSize();
    const margin = Math.min(width, height) * 0.05;
    const size = Math.max(1, Math.min(8, (height - margin * 2) / chunk.length));
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
    chunk.forEach((line, i) => {
      // Squeezed to the page width: invisible, so only its place matters.
      const natural = font.widthOfTextAtSize(line, size);
      const fit = Math.min(size, (size * (width - margin * 2)) / Math.max(natural, 1));
      page.drawText(line, {
        x: margin,
        y: height - margin - (i + 1) * size,
        size: Math.max(0.5, fit),
        font,
      });
    });
    page.pushOperators(popGraphicsState());
  });
  return document.save();
}
