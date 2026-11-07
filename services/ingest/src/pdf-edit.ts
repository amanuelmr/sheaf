import { PDFDocument, degrees } from 'pdf-lib';

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
