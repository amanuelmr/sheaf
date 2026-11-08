/** Exporting the document list as a spreadsheet. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { cell } from '../src/csv-export';
import { CustomFields } from '../src/custom-fields';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const NOW = Date.parse('2026-03-01T09:00:00Z');
const TOKEN = 'admin-token-for-csv';

async function setUp() {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-csv-')),
  });
  const customFields = new CustomFields(driver, storage);
  const deps = { storage, customFields, token: TOKEN, now: () => NOW };
  const get = async (query: string) => {
    const response = await handle(
      {
        method: 'GET',
        path: paths.searchExport(),
        query,
        headers: { authorization: `Bearer ${TOKEN}` },
        body: new Uint8Array(),
      },
      deps,
    );
    return { ...response, text: new TextDecoder().decode(response.bytes) };
  };
  return { storage, customFields, get };
}

suite('exporting documents as CSV', () => {
  it('writes a row per matching document with a column per custom field', async () => {
    const { storage, customFields, get } = await setUp();
    const [a, b] = [pdf('a'), pdf('b')];
    await storage.put(sha256Hex(a), a, NOW, 1);
    await storage.put(sha256Hex(b), b, NOW + 1, 1);
    await storage.patch(sha256Hex(a), {
      title: 'Power, "March"',
      correspondent: 'City Power',
      tags: ['bills', 'home'],
      created: '2026-02-27',
    });
    await storage.patch(sha256Hex(b), { title: 'Lease', tags: ['home'] });
    const total = await customFields.create({ name: 'Total', type: 'monetary' }, NOW);
    if (!total.ok) throw new Error('field');
    await customFields.setValues(
      sha256Hex(a),
      [{ field: total.value.id, value: { minor: 4250, currency: 'EUR' } }],
      NOW,
    );

    const response = await get('tag=bills');
    expect(response.status).toBe(200);
    expect(response.headers?.['content-type']).toMatch(/text\/csv/);
    expect(response.headers?.['x-sheaf-truncated']).toBe('false');
    expect(response.text.replace(/^\uFEFF/, '').split('\r\n')).toEqual([
      'id,title,created,received,correspondent,document type,tags,asn,Total',
      `${sha256Hex(a)},"Power, ""March""",2026-02-27,2026-03-01T09:00:00.000Z,City Power,,bills; home,,42.50 EUR`,
      '',
    ]);
    expect((await get('')).text.split('\r\n')).toHaveLength(4);
    expect((await get('q=%21%21')).text.split('\r\n')).toHaveLength(2);
  });

  it('never hands a spreadsheet a formula', () => {
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(cell('-1+2')).toBe("'-1+2");
    expect(cell('plain')).toBe('plain');
  });
});
