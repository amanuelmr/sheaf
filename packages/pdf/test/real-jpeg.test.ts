/**
 * The synthetic fixtures in `fixtures.ts` only ever contained a frame header, which
 * meant the parser had never seen a file a camera produced, and the PDF writer had
 * never been checked by anything other than its own author's regexes.
 *
 * These fixtures are real JPEGs. The Ghostscript case is the important one: it is
 * the only assertion here that does not depend on my own understanding of the
 * format being right.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe as suite, expect, it } from 'vitest';
import { assemble } from '../src/pdf';
import { readJpegInfo } from '../src/jpeg';
import { indexOfBytes, text } from './fixtures';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const rgb = fixture('photo-rgb.jpg');
const small = fixture('photo-small.jpg');
const gray = fixture('photo-gray.jpg');

const hasGhostscript = (() => {
  try {
    execFileSync('gs', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

suite('real JPEG files', () => {
  it('reads the dimensions an encoder actually wrote', () => {
    expect(readJpegInfo(rgb)).toEqual({
      width: 200,
      height: 260,
      components: 3,
      progressive: false,
    });
    expect(readJpegInfo(small)).toEqual({
      width: 100,
      height: 130,
      components: 3,
      progressive: false,
    });
  });

  it('recognises a genuinely greyscale file', () => {
    const info = readJpegInfo(gray);
    expect(info?.components).toBe(1);
    expect(
      text(
        assemble([gray]).ok ? (assemble([gray]) as { bytes: Uint8Array }).bytes : new Uint8Array(),
      ),
    ).toContain('/ColorSpace /DeviceGray');
  });

  it('assembles real photographs and embeds them untouched', () => {
    const result = assemble([rgb, gray, small]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(3);
    for (const page of [rgb, gray, small]) {
      expect(indexOfBytes(result.bytes, page)).toBeGreaterThan(0);
    }
  });

  it('hashes real photographs the same way twice', () => {
    const a = assemble([rgb, small]);
    const b = assemble([rgb, small]);
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
  });
});

suite('validated by something other than this codebase', () => {
  it.runIf(hasGhostscript)('is parsed by Ghostscript, at the right page geometry', () => {
    const result = assemble([rgb, small]);
    if (!result.ok) throw new Error('assembly failed');

    const dir = mkdtempSync(join(tmpdir(), 'sheaf-pdf-'));
    const pdf = join(dir, 'doc.pdf');
    writeFileSync(pdf, result.bytes);

    // -dPDFSTOPONERROR makes Ghostscript strict: any structural problem is fatal.
    const output = execFileSync(
      'gs',
      ['-dNOPAUSE', '-dBATCH', '-dNODISPLAY', '-sDEVICE=nullpage', '-dPDFSTOPONERROR', pdf],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toContain('Processing pages 1 through 2');
    expect(output).toContain('Page 2');

    // Render at a known resolution and check the page really is the size we declared:
    // 200px at 150dpi is 96pt, which is 48px at 36dpi.
    execFileSync('gs', [
      '-dNOPAUSE',
      '-dBATCH',
      '-q',
      '-sDEVICE=ppmraw',
      '-r36',
      `-sOutputFile=${join(dir, 'page-%d.ppm')}`,
      pdf,
    ]);
    const page = readFileSync(join(dir, 'page-1.ppm'));
    const { width, height, pixels } = readPpm(page);
    expect([width, height]).toEqual([48, 62]);

    // And the image is actually drawn: a blank page would be pure white.
    const distinct = new Set(pixels.map((p) => p.join(',')));
    expect(distinct.has('255,255,255')).toBe(false);
    expect(distinct.size).toBeLessThan(8); // a flat source stays flat once embedded
  });

  it('records whether that check ran', () => {
    // Not a real assertion — it keeps the skip visible rather than silent.
    expect(typeof hasGhostscript).toBe('boolean');
  });
});

/** Minimal P6 reader. Ghostscript writes a comment line, so tokenise properly. */
function readPpm(raw: Buffer): {
  width: number;
  height: number;
  pixels: Array<[number, number, number]>;
} {
  let i = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(raw[i]!))) i++;
    if (raw[i] === 0x23) {
      while (raw[i] !== 0x0a) i++;
      continue;
    }
    let j = i;
    while (!/\s/.test(String.fromCharCode(raw[j]!))) j++;
    tokens.push(raw.subarray(i, j).toString());
    i = j;
  }
  i += 1;
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const body = raw.subarray(i);
  const pixels: Array<[number, number, number]> = [];
  for (let p = 0; p < width * height; p++) {
    pixels.push([body[p * 3]!, body[p * 3 + 1]!, body[p * 3 + 2]!]);
  }
  return { width, height, pixels };
}
