import { readJpegInfo, type JpegInfo } from './jpeg';
import { sha256Hex } from './sha256';

/**
 * A minimal PDF writer, deliberately hand-rolled.
 *
 * ADR 0002 makes the document's identity `SHA-256(assembled PDF bytes)`, which
 * means assembly has to be byte-deterministic: the same pages must always produce
 * the same file. Every PDF library writes a `/CreationDate` and a `/Producer`
 * string, and some write a random `/ID` — so with a library the hash would change
 * on every run, on every dependency bump, and identity would quietly break.
 *
 * Nothing here reads a clock, a locale, or a random source. The only inputs are
 * the page bytes and their order.
 */

export interface AssembleOptions {
  /**
   * Assumed scan resolution, used only to size the page in points. It changes the
   * bytes, so changing it changes every hash — hence an explicit default rather
   * than a caller-by-caller choice.
   */
  readonly dpi?: number;
}

export type AssembleError =
  | { readonly kind: 'no_pages' }
  | { readonly kind: 'unsupported_page'; readonly index: number; readonly detail: string };

export type AssembleResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** The document's identity. */
      readonly sha256: string;
      readonly pageCount: number;
    }
  | { readonly ok: false; readonly error: AssembleError };

export const DEFAULT_DPI = 150;

export function assemble(
  pages: readonly Uint8Array[],
  options: AssembleOptions = {},
): AssembleResult {
  if (pages.length === 0) return { ok: false, error: { kind: 'no_pages' } };
  const dpi = options.dpi ?? DEFAULT_DPI;

  const infos: JpegInfo[] = [];
  for (const [index, page] of pages.entries()) {
    const info = readJpegInfo(page);
    if (info === null) {
      return {
        ok: false,
        error: { kind: 'unsupported_page', index, detail: 'not a readable JPEG' },
      };
    }
    if (info.components !== 1 && info.components !== 3 && info.components !== 4) {
      return {
        ok: false,
        error: {
          kind: 'unsupported_page',
          index,
          detail: `unsupported colour space (${info.components} components)`,
        },
      };
    }
    infos.push(info);
  }

  const writer = new PdfWriter();
  const bytes = writer.write(pages, infos, dpi);
  return { ok: true, bytes, sha256: sha256Hex(bytes), pageCount: pages.length };
}

const CATALOG = 1;
const PAGES = 2;
const FIRST_PAGE_OBJECT = 3;
const OBJECTS_PER_PAGE = 3;

class PdfWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private readonly offsets = new Map<number, number>();

  write(pages: readonly Uint8Array[], infos: readonly JpegInfo[], dpi: number): Uint8Array {
    // 1.4 is the oldest version that covers everything used here, so the file
    // stays readable by the widest range of viewers.
    this.ascii('%PDF-1.4\n');
    // A binary comment marks the file as binary for tools that sniff it.
    this.raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const pageIds = pages.map((_, i) => FIRST_PAGE_OBJECT + i * OBJECTS_PER_PAGE);

    this.object(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
    this.object(
      PAGES,
      `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    );

    pages.forEach((jpeg, index) => {
      const info = infos[index]!;
      const pageId = pageIds[index]!;
      const contentsId = pageId + 1;
      const imageId = pageId + 2;
      const width = points(info.width, dpi);
      const height = points(info.height, dpi);

      this.object(
        pageId,
        `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentsId} 0 R >>`,
      );

      // Scale the image to exactly fill the page.
      const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`;
      this.streamObject(contentsId, `<< /Length ${byteLength(content)} >>`, latin1(content));

      this.streamObject(
        imageId,
        `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
          `/ColorSpace ${colorSpace(info.components)} /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${jpeg.length} >>`,
        jpeg,
      );
    });

    const objectCount = FIRST_PAGE_OBJECT + pages.length * OBJECTS_PER_PAGE;
    const xrefOffset = this.length;

    // Classic cross-reference table. Every entry is exactly 20 bytes.
    this.ascii(`xref\n0 ${objectCount}\n`);
    this.ascii('0000000000 65535 f \n');
    for (let id = 1; id < objectCount; id++) {
      const offset = this.offsets.get(id) ?? 0;
      this.ascii(`${offset.toString().padStart(10, '0')} 00000 n \n`);
    }

    // No /ID, no /Producer, no /CreationDate. Those are what make PDFs
    // irreproducible, and identity here depends on reproducibility.
    this.ascii(`trailer\n<< /Size ${objectCount} /Root ${CATALOG} 0 R >>\n`);
    this.ascii(`startxref\n${xrefOffset}\n%%EOF\n`);

    return this.concat();
  }

  private object(id: number, body: string): void {
    this.offsets.set(id, this.length);
    this.ascii(`${id} 0 obj\n${body}\nendobj\n`);
  }

  private streamObject(id: number, dictionary: string, data: Uint8Array): void {
    this.offsets.set(id, this.length);
    this.ascii(`${id} 0 obj\n${dictionary}\nstream\n`);
    this.raw(data);
    this.ascii('\nendstream\nendobj\n');
  }

  private ascii(text: string): void {
    this.raw(latin1(text));
  }

  private raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  private concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

function colorSpace(components: number): string {
  if (components === 1) return '/DeviceGray';
  if (components === 4) return '/DeviceCMYK';
  return '/DeviceRGB';
}

/**
 * Pixels to PDF points, formatted so the output never depends on how a particular
 * engine chooses to print a float. `toFixed` is specified exactly; string
 * concatenation of a raw number is not.
 */
function points(pixels: number, dpi: number): string {
  const value = (pixels * 72) / dpi;
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function byteLength(text: string): number {
  return text.length;
}
