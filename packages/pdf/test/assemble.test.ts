import { describe as suite, expect, it } from 'vitest';
import { assemble, DEFAULT_DPI } from '../src/pdf';
import { indexOfBytes, jpeg, text } from './fixtures';

const pageA = jpeg({ width: 1500, height: 2100, fill: 0x11 });
const pageB = jpeg({ width: 1200, height: 1600, fill: 0x22 });

function assembled(pages: readonly Uint8Array[], dpi?: number) {
  const result = assemble(pages, dpi === undefined ? {} : { dpi });
  if (!result.ok) throw new Error(`assembly failed: ${JSON.stringify(result.error)}`);
  return result;
}

suite('determinism', () => {
  it('produces byte-identical output for the same pages', () => {
    const first = assembled([pageA, pageB]);
    const second = assembled([pageA, pageB]);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.sha256).toBe(first.sha256);
  });

  it('writes nothing that varies between runs', () => {
    // These are what make an ordinary PDF irreproducible, and identity depends on
    // reproducibility. If a future change reintroduces one, this test says so.
    const body = text(assembled([pageA]).bytes);
    for (const forbidden of ['/CreationDate', '/ModDate', '/Producer', '/Creator', '/ID']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('gives a different identity to a different page order', () => {
    expect(assembled([pageA, pageB]).sha256).not.toBe(assembled([pageB, pageA]).sha256);
  });

  it('gives a different identity when a single page byte changes', () => {
    const altered = new Uint8Array(pageA);
    altered[altered.length - 4] = 0x99;
    expect(assembled([altered]).sha256).not.toBe(assembled([pageA]).sha256);
  });

  it('gives a different identity to a different page count', () => {
    expect(assembled([pageA]).sha256).not.toBe(assembled([pageA, pageA]).sha256);
  });

  it('treats the assumed resolution as identity-affecting', () => {
    // Documented consequence: changing DEFAULT_DPI rehashes every future document.
    expect(assembled([pageA], 150).sha256).not.toBe(assembled([pageA], 300).sha256);
  });
});

suite('structure', () => {
  it('is a well-formed PDF envelope', () => {
    const body = text(assembled([pageA, pageB]).bytes);
    expect(body.startsWith('%PDF-1.4\n')).toBe(true);
    expect(body.endsWith('%%EOF\n')).toBe(true);
    expect(body).toContain('/Type /Catalog');
    expect(body).toContain('/Type /Pages');
    expect(body).toContain('/Count 2');
  });

  it('points startxref at the cross-reference table', () => {
    const bytes = assembled([pageA, pageB]).bytes;
    const body = text(bytes);
    const declared = Number(/startxref\n(\d+)\n/.exec(body)![1]);
    expect(body.slice(declared, declared + 4)).toBe('xref');
  });

  it('writes cross-reference offsets that actually locate their objects', () => {
    // The check that catches an off-by-one in the writer rather than in the hash.
    const body = text(assembled([pageA, pageB]).bytes);
    const xrefAt = Number(/startxref\n(\d+)\n/.exec(body)![1]);
    const table = body.slice(xrefAt);
    const size = Number(/\/Size (\d+)/.exec(body)![1]);
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];

    expect(entries).toHaveLength(size);
    expect(entries[0]![3]).toBe('f'); // object 0 is always the free head
    entries.slice(1).forEach((entry, i) => {
      const offset = Number(entry[1]);
      expect(body.slice(offset, offset + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(
        `${i + 1} 0 obj`,
      );
    });
  });

  it('sizes the page from the image and the assumed resolution', () => {
    // 1500 x 2100 px at 150 dpi is 10 x 14 inches, so 720 x 1008 points.
    expect(text(assembled([pageA], 150).bytes)).toContain('/MediaBox [0 0 720 1008]');
    expect(text(assembled([pageA], 300).bytes)).toContain('/MediaBox [0 0 360 504]');
    expect(DEFAULT_DPI).toBe(150);
  });

  it('declares the colour space the JPEG actually uses', () => {
    expect(text(assembled([jpeg({ width: 4, height: 4, components: 1 })]).bytes)).toContain(
      '/ColorSpace /DeviceGray',
    );
    expect(text(assembled([jpeg({ width: 4, height: 4, components: 3 })]).bytes)).toContain(
      '/ColorSpace /DeviceRGB',
    );
    expect(text(assembled([jpeg({ width: 4, height: 4, components: 4 })]).bytes)).toContain(
      '/ColorSpace /DeviceCMYK',
    );
  });

  it('embeds the camera bytes verbatim, with no re-encoding', () => {
    // DCTDecode means the JPEG goes in as-is: no decode, no quality loss, and
    // nothing for a codec version to change between runs.
    const result = assembled([pageA, pageB]);
    expect(indexOfBytes(result.bytes, pageA)).toBeGreaterThan(0);
    expect(indexOfBytes(result.bytes, pageB)).toBeGreaterThan(0);
    expect(text(result.bytes)).toContain('/Filter /DCTDecode');
  });

  it('declares each stream length correctly', () => {
    const body = text(assembled([pageA]).bytes);
    const declared = [...body.matchAll(/\/Length (\d+)/g)].map((m) => Number(m[1]));
    expect(declared).toContain(pageA.length);
  });
});

suite('refusals', () => {
  it('will not assemble nothing', () => {
    expect(assemble([])).toEqual({ ok: false, error: { kind: 'no_pages' } });
  });

  it('names the page it could not read', () => {
    const result = assemble([pageA, new Uint8Array([1, 2, 3]), pageB]);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'unsupported_page', index: 1, detail: 'not a readable JPEG' },
    });
  });

  it('refuses a colour space it cannot declare', () => {
    const result = assemble([jpeg({ width: 4, height: 4, components: 2 })]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'unsupported_page') {
      expect(result.error.detail).toContain('colour space');
    }
  });

  it('reports the page count on success', () => {
    expect(assembled([pageA, pageB, pageA].slice(0, 3)).pageCount).toBe(3);
  });
});
