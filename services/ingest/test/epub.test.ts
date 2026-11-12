/** Taking EPUB books in as documents. */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { ConsumeFolder } from '../src/consume';
import { epubToPdf, isEpub, wrap, xhtmlToText } from '../src/epub';
import { parseMail } from '../src/mime';
import { handle } from '../src/router';
import { Storage } from '../src/storage';

const NOW = 1_700_000_000_000;
const TOKEN = 'admin-token-epub-books';

/** A ZIP as an EPUB is packed: the mimetype first and stored, the rest deflated. */
export function zip(files: readonly [string, string][]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  files.forEach(([name, content], i) => {
    const raw = Buffer.from(content, 'utf8');
    const stored = i === 0;
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const chapter = (heading: string, body: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{}</style></head>` +
  `<body><h1>${heading}</h1><p>${body}</p></body></html>`;

export function book(title = 'The Tenancy Handbook'): Uint8Array {
  return zip([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ],
    [
      'OEBPS/content.opf',
      `<package><metadata><dc:title>${title}</dc:title><dc:creator>Ann Example</dc:creator></metadata>` +
        '<manifest><item id="c2" href="text/two.xhtml"/><item id="c1" href="text/one.xhtml"/></manifest>' +
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    ],
    [
      'OEBPS/text/one.xhtml',
      chapter('Deposits', 'A deposit is held by the landlord &amp; returned.'),
    ],
    ['OEBPS/text/two.xhtml', chapter('Repairs', `Ask in writing. ${'Keep a copy. '.repeat(400)}`)],
  ]);
}

suite('reading an EPUB', () => {
  it('turns its chapters into a PDF in reading order, with its title and words', async () => {
    const bytes = book();
    expect(isEpub(bytes)).toBe(true);
    expect(isEpub(new Uint8Array(Buffer.from('%PDF-1.4')))).toBe(false);
    const converted = await epubToPdf(bytes);
    expect(converted.title).toBe('The Tenancy Handbook');
    expect(converted.author).toBe('Ann Example');
    expect(converted.text.indexOf('Deposits')).toBeLessThan(converted.text.indexOf('Repairs'));
    expect(converted.text).toContain('held by the landlord & returned.');
    const pdf = await PDFDocument.load(converted.pdf);
    expect(pdf.getTitle()).toBe('The Tenancy Handbook');
    // A title page, a chapter page, and the long chapter running over several.
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    // The same book always becomes the same PDF, and so the same document.
    expect(Buffer.from((await epubToPdf(bytes)).pdf)).toEqual(Buffer.from(converted.pdf));
  });

  it('cuts a word too long for a line into the longest pieces that fit, quickly', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman);
    const fits = (s: string) => font.widthOfTextAtSize(s, 11) <= 300;
    const word = 'abcdefghij'.repeat(10_000);
    const started = performance.now();
    const lines = wrap(`short ${word} end`, font, 11, 300);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(lines[0]).toBe('short');
    // The word's last piece shares its line with the word after it.
    expect(lines.slice(1).join('')).toBe(`${word} end`);
    for (const line of lines.slice(1, -1)) {
      expect(fits(line)).toBe(true);
      expect(fits(line + 'x')).toBe(false);
    }
  });

  it('reads paragraphs as lines and drops styles and scripts', () => {
    expect(
      xhtmlToText(
        '<body><style>x</style><p>One&nbsp;two</p><script>no()</script>three<br/>four</body>',
      ),
    ).toBe('One two\nthree\nfour');
  });
});

suite('taking books in', () => {
  async function storage() {
    return Storage.open({
      driver: nodeSqliteDriver(),
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-epub-')),
    });
  }

  it('stores a book sent to the API once, titled and searchable', async () => {
    const store = await storage();
    const send = () =>
      handle(
        {
          method: 'POST',
          path: paths.books(),
          query: '',
          headers: { authorization: `Bearer ${TOKEN}` },
          body: book(),
        },
        { storage: store, token: TOKEN, now: () => NOW },
      );
    const first = await send();
    expect(first.status).toBe(201);
    const record = first.json as { sha256: string; title: string };
    expect(record.title).toBe('The Tenancy Handbook');
    expect((await send()).status).toBe(200);
    const found = await store.search('"landlord"', 10, 0);
    expect(found.hits.map((h) => h.sha256)).toEqual([record.sha256]);

    const refused = await handle(
      {
        method: 'POST',
        path: paths.books(),
        query: '',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: new Uint8Array(Buffer.from('%PDF-1.4 not a book')),
      },
      { storage: store, token: TOKEN, now: () => NOW },
    );
    expect(refused.status).toBe(400);
  });

  it('takes a book from the consume folder, tagged by its folder', async () => {
    const store = await storage();
    const dir = mkdtempSync(join(tmpdir(), 'sheaf-epub-in-'));
    mkdirSync(join(dir, 'reading'));
    const path = join(dir, 'reading', 'handbook.epub');
    writeFileSync(path, book());
    const folder = new ConsumeFolder(store, dir, { now: () => NOW, subdirsAsTags: true });
    await folder.tick();
    const result = await folder.tick();
    expect(result.stored).toBe(1);
    expect(existsSync(path)).toBe(false);
    const hit = (await store.search('"deposit"', 10, 0)).hits[0];
    expect(hit?.tags).toEqual(['reading']);
  });

  it('finds a book attached to an email', () => {
    const encoded = Buffer.from(book()).toString('base64');
    const mail = Buffer.from(
      [
        'Subject: Reading',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: application/epub+zip; name="handbook.epub"',
        'Content-Transfer-Encoding: base64',
        '',
        encoded,
        '--b--',
        '',
      ].join('\r\n'),
    );
    const parsed = parseMail(new Uint8Array(mail));
    expect(parsed.attachments).toHaveLength(1);
    expect(isEpub(parsed.attachments[0]!.bytes)).toBe(true);
  });
});
