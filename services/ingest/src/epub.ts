import { inflateRawSync } from 'node:zlib';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { sha256Hex, type Storage } from './storage.ts';

/** An EPUB as Sheaf keeps it: a PDF to read and file, and the book's own words. */
export interface ConvertedBook {
  readonly pdf: Uint8Array;
  readonly title: string | null;
  readonly author: string | null;
  /** Every chapter's text in reading order, for search without recognising anything. */
  readonly text: string;
}

/** Larger books are refused rather than held in memory whole. */
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export class NotAnEpub extends Error {}

/** Does this look like an EPUB: a ZIP whose first entry says it is one? */
export function isEpub(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 58)).toString('latin1');
  return head.startsWith('PK\x03\x04') && head.includes('mimetypeapplication/epub+zip');
}

/**
 * An EPUB as a PDF: a title page, then each chapter in reading order as plain
 * text, wrapped to an A5 page. Pictures, tables and styling are left out: what is
 * kept is what a person searches and files a book by. Characters the built-in
 * font cannot draw become spaces in the PDF, and stay in `text`.
 */
export async function epubToPdf(bytes: Uint8Array): Promise<ConvertedBook> {
  const files = unzip(bytes);
  const read = (path: string): string | null => {
    const entry = files.get(path);
    return entry === undefined ? null : Buffer.from(entry()).toString('utf8');
  };
  const container = read('META-INF/container.xml');
  const opfPath = container === null ? null : /full-path\s*=\s*"([^"]+)"/.exec(container)?.[1];
  if (opfPath === undefined || opfPath === null) throw new NotAnEpub('no META-INF/container.xml');
  const opf = read(opfPath);
  if (opf === null) throw new NotAnEpub(`no ${opfPath}`);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const title = textOf(firstMatch(opf, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i));
  const author = textOf(firstMatch(opf, /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i));
  const manifest = new Map<string, string>();
  for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attribute(item[0], 'id');
    const href = attribute(item[0], 'href');
    if (id !== null && href !== null) manifest.set(id, href);
  }
  const chapters: string[] = [];
  for (const ref of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const href = manifest.get(attribute(ref[0], 'idref') ?? '');
    if (href === undefined) continue;
    const xhtml = read(resolvePath(base, decodeURIComponent(href.split('#')[0]!)));
    if (xhtml === null) continue;
    const text = xhtmlToText(xhtml);
    if (text !== '') chapters.push(text);
  }
  const text = chapters.join('\n\n');
  return { pdf: await render(title, author, chapters), title, author, text };
}

/** Paragraphs as lines, everything else as the words it holds. */
export function xhtmlToText(xhtml: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] ?? xhtml;
  return decodeEntities(
    body
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

const A5: [number, number] = [419.53, 595.28];
const MARGIN = 48;
const SIZE = 10.5;
const LEADING = 14;

async function render(
  title: string | null,
  author: string | null,
  chapters: readonly string[],
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  if (title !== null) document.setTitle(title);
  if (author !== null) document.setAuthor(author);
  // Fixed dates, so the same book always becomes the same bytes and the same document.
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const font = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  const known = new Set(font.getCharacterSet());
  const drawable = (s: string) =>
    [...s.normalize('NFC')].map((ch) => (known.has(ch.codePointAt(0)!) ? ch : ' ')).join('');
  const width = A5[0] - MARGIN * 2;

  const cover = document.addPage(A5);
  let y = A5[1] - MARGIN * 3;
  for (const line of wrap(drawable(title ?? 'Untitled book'), bold, 20, width)) {
    cover.drawText(line, { x: MARGIN, y, size: 20, font: bold });
    y -= 26;
  }
  if (author !== null) {
    y -= 10;
    for (const line of wrap(drawable(author), font, 13, width)) {
      cover.drawText(line, { x: MARGIN, y, size: 13, font });
      y -= 18;
    }
  }

  for (const chapter of chapters) {
    let page = document.addPage(A5);
    y = A5[1] - MARGIN;
    for (const paragraph of chapter.split('\n')) {
      for (const line of wrap(drawable(paragraph), font, SIZE, width)) {
        if (y < MARGIN + LEADING) {
          page = document.addPage(A5);
          y = A5[1] - MARGIN;
        }
        y -= LEADING;
        page.drawText(line, { x: MARGIN, y, size: SIZE, font });
      }
      y -= LEADING / 2;
    }
  }
  return document.save();
}

/** Lines no wider than `width`, broken between words; a word wider than that alone is cut. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line !== '') lines.push(line);
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line !== '') lines.push(line);
  return lines;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

function textOf(xml: string | null): string | null {
  if (xml === null) return null;
  const text = decodeEntities(xml.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match === null ? null : decodeEntities(match[2] ?? match[3] ?? '');
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = parseInt(name.slice(2), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** `href` relative to the folder `base`, with `..` taken out; never above the book's root. */
function resolvePath(base: string, href: string): string {
  const parts: string[] = [];
  for (const part of `${base}${href}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/**
 * The files in a ZIP, by path, each unpacked only when asked for. Reads the
 * central directory, so it needs the whole file; stored and deflated entries only,
 * which is all an EPUB uses.
 */
export function unzip(bytes: Uint8Array): ReadonlyMap<string, () => Uint8Array> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new NotAnEpub('not a ZIP file');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES) throw new NotAnEpub('too many files inside');
  const files = new Map<string, () => Uint8Array>();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) {
      throw new NotAnEpub('a damaged ZIP directory');
    }
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw new NotAnEpub('too large once unpacked');
    files.set(name, () => {
      if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) {
        throw new NotAnEpub(`a damaged entry: ${name}`);
      }
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const raw = data.subarray(start, start + compressed);
      if (method === 0) return new Uint8Array(raw);
      if (method === 8) return new Uint8Array(inflateRawSync(raw, { maxOutputLength: size + 1 }));
      throw new NotAnEpub(`${name} is packed in a way EPUBs do not use`);
    });
  }
  return files;
}

/**
 * Keep an EPUB as a document: its PDF stored like any other, the book's own text
 * kept so it is searchable at once, and its title used when it has none yet.
 * Converting is deterministic, so the same book arrives as the same document.
 */
export async function storeBook(
  storage: Storage,
  bytes: Uint8Array,
  now: number,
  /** The person who sent it, whose it then is; null shares it with everyone. */
  ownerId: number | null = null,
): Promise<{ readonly sha256: string; readonly outcome: 'stored' | 'already-stored' }> {
  const book = await epubToPdf(bytes);
  const sha256 = sha256Hex(book.pdf);
  const pages = (await PDFDocument.load(book.pdf)).getPageCount();
  const outcome = await storage.put(sha256, book.pdf, now, pages, null, ownerId);
  if (outcome === 'stored') {
    if (book.text !== '') {
      await storage.putText(sha256, { source: 'epub', engine: 'epub', text: book.text }, now);
    }
    if (book.title !== null && (await storage.record(sha256))?.title === null) {
      await storage.fileByMachine(sha256, { title: book.title.slice(0, 300) });
    }
  }
  return { sha256, outcome };
}
