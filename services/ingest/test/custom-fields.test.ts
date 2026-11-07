/**
 * Custom fields: definitions, values checked against their type, links kept in
 * both directions, and values searchable with the rest of the document.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import {
  customFieldValueProblem,
  isCustomFieldBody,
  isCustomFieldPatch,
  isCustomFieldValuesBody,
  type CustomField,
  type CustomFieldType,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const NOW = 1_700_000_000_000;

let driver: SqlDriver;
let storage: Storage;
let fields: CustomFields;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-cf-')) });
  fields = new CustomFields(driver, storage);
  for (const [hash, bytes] of [
    [hashA, A],
    [hashB, B],
    [hashC, C],
  ] as const) {
    await storage.put(hash, bytes, NOW, 1);
  }
});

async function make(name: string, type: CustomFieldType, options?: string[]): Promise<CustomField> {
  const created = await fields.create({ name, type, ...(options ? { options } : {}) }, NOW);
  if (!created.ok) throw new Error(`could not create ${name}`);
  return created.value;
}

const find = async (q: string): Promise<string[]> =>
  (await storage.search(toMatch(q)!, 20, 0)).hits.map((hit) => hit.sha256);

suite('defining fields', () => {
  it('creates, lists by name and counts the documents carrying each', async () => {
    const invoice = await make('Invoice number', 'text');
    await make('Amount', 'monetary');
    await fields.setValues(hashA, [{ field: invoice.id, value: 'INV-1' }], NOW);

    const listed = await fields.list();
    expect(listed.map((f) => [f.name, f.type, f.documentCount])).toEqual([
      ['Amount', 'monetary', 0],
      ['Invoice number', 'text', 1],
    ]);
  });

  it('refuses a second field with the same name, whatever its case', async () => {
    await make('Invoice', 'text');
    const again = await fields.create({ name: 'invoice', type: 'integer' }, NOW);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.kind).toBe('conflict');
  });

  it('answers conflict, not a crash, when two requests create the same name at once', async () => {
    const results = await Promise.all([
      fields.create({ name: 'Due', type: 'date' }, NOW),
      fields.create({ name: 'due', type: 'text' }, NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.map((r) => (r.ok ? 'created' : r.kind)).sort()).toEqual(['conflict', 'created']);
    expect(await fields.list()).toHaveLength(1);
  });

  it('renames a field, but not onto another field’s name', async () => {
    const a = await make('A', 'text');
    await make('B', 'text');
    expect((await fields.update(a.id, { name: 'Renamed' }, NOW)).ok).toBe(true);
    const clash = await fields.update(a.id, { name: 'b' }, NOW);
    expect(!clash.ok && clash.kind).toBe('conflict');
    expect((await fields.get(a.id))?.name).toBe('Renamed');
  });

  it('gives options only to a select', async () => {
    const text = await make('Text', 'text');
    const refused = await fields.update(text.id, { options: ['x'] }, NOW);
    expect(!refused.ok && refused.kind).toBe('invalid');
  });

  it('clears a value whose option was dropped, and keeps the field on the document', async () => {
    const status = await make('Status', 'select', ['open', 'paid']);
    await fields.setValues(hashA, [{ field: status.id, value: 'paid' }], NOW);
    await fields.setValues(hashB, [{ field: status.id, value: 'open' }], NOW);

    await fields.update(status.id, { options: ['open', 'void'] }, NOW);
    expect((await fields.valuesOf(hashA))[0]?.value).toBeNull();
    expect((await fields.valuesOf(hashB))[0]?.value).toBe('open');
  });

  it('deletes a field together with every value of it', async () => {
    const note = await make('Ref', 'text');
    await fields.setValues(hashA, [{ field: note.id, value: 'zebra' }], NOW);
    expect(await find('zebra')).toEqual([hashA]);

    expect(await fields.remove(note.id)).toBe(true);
    expect(await fields.valuesOf(hashA)).toEqual([]);
    expect(await find('zebra')).toEqual([]);
    expect(await fields.remove(note.id)).toBe(false);
  });
});

suite('values on a document', () => {
  it('sets exactly the fields given, replacing what was there', async () => {
    const a = await make('A', 'text');
    const b = await make('B', 'integer');
    await fields.setValues(hashA, [{ field: a.id, value: 'x' }], NOW);
    await fields.setValues(
      hashA,
      [
        { field: b.id, value: 7 },
        { field: a.id, value: null },
      ],
      NOW,
    );
    expect((await fields.valuesOf(hashA)).map((v) => [v.name, v.value])).toEqual([
      ['A', null],
      ['B', 7],
    ]);
  });

  it('refuses a value that does not fit, and changes nothing', async () => {
    const amount = await make('Amount', 'integer');
    await fields.setValues(hashA, [{ field: amount.id, value: 1 }], NOW);
    const refused = await fields.setValues(hashA, [{ field: amount.id, value: 1.5 }], NOW);
    expect(!refused.ok && refused.kind).toBe('invalid');
    expect((await fields.valuesOf(hashA))[0]?.value).toBe(1);
  });

  it('refuses an unknown field, and an unknown document', async () => {
    const unknownField = await fields.setValues(hashA, [{ field: 99, value: null }], NOW);
    expect(!unknownField.ok && unknownField.kind).toBe('invalid');
    const nope = await fields.setValues(sha256Hex(pdf('nope')), [], NOW);
    expect(!nope.ok && nope.kind).toBe('not_found');
  });

  it('makes text values and field names searchable', async () => {
    const ref = await make('Policy number', 'text');
    await fields.setValues(hashB, [{ field: ref.id, value: 'PX-4471' }], NOW);
    expect(await find('4471')).toEqual([hashB]);
    expect(await find('policy')).toEqual([hashB]);
  });
});

suite('document links', () => {
  it('links both ways, and unlinks both ways', async () => {
    const related = await make('Related', 'documentLink');
    await fields.setValues(hashA, [{ field: related.id, value: [hashB, hashC] }], NOW);
    expect((await fields.valuesOf(hashB))[0]?.value).toEqual([hashA]);
    expect((await fields.valuesOf(hashC))[0]?.value).toEqual([hashA]);

    await fields.setValues(hashA, [{ field: related.id, value: [hashB] }], NOW);
    expect((await fields.valuesOf(hashC))[0]?.value).toEqual([]);
    expect((await fields.valuesOf(hashB))[0]?.value).toEqual([hashA]);
  });

  it('keeps the other side’s existing links when adding one', async () => {
    const related = await make('Related', 'documentLink');
    await fields.setValues(hashB, [{ field: related.id, value: [hashC] }], NOW);
    await fields.setValues(hashA, [{ field: related.id, value: [hashB] }], NOW);
    expect((await fields.valuesOf(hashB))[0]?.value).toEqual([hashC, hashA]);
  });

  it('refuses a link that would give the other document more links than allowed', async () => {
    const related = await make('Related', 'documentLink');
    const label = await make('Label', 'text');
    // B already holds the most links a document may.
    const full = Array.from({ length: 100 }, (_, i) => sha256Hex(pdf(`filler-${String(i)}`)));
    await driver.run(
      'INSERT INTO custom_field_values (sha256, field_id, value_json, updated_at) VALUES (?, ?, ?, ?)',
      [hashB, related.id, JSON.stringify(full), NOW],
    );

    const refused = await fields.setValues(hashA, [{ field: related.id, value: [hashB] }], NOW);
    expect(!refused.ok && refused.kind === 'invalid' && refused.message).toMatch(
      /already links 100 documents/,
    );
    expect(await fields.valuesOf(hashA)).toEqual([]);

    // A's other fields still save, with no link to B.
    const saved = await fields.setValues(hashA, [{ field: label.id, value: 'ok' }], NOW);
    expect(saved.ok).toBe(true);
  });

  it('refuses a link to itself or to a document it does not hold', async () => {
    const related = await make('Related', 'documentLink');
    const self = await fields.setValues(hashA, [{ field: related.id, value: [hashA] }], NOW);
    expect(self.ok).toBe(false);
    const missing = await fields.setValues(
      hashA,
      [{ field: related.id, value: [sha256Hex(pdf('nope'))] }],
      NOW,
    );
    expect(missing.ok).toBe(false);
  });

  it('removes links to a purged document from the documents that held them', async () => {
    const related = await make('Related', 'documentLink');
    await fields.setValues(hashA, [{ field: related.id, value: [hashB, hashC] }], NOW);
    await storage.trash(hashB, NOW);
    await storage.purge(hashB);

    const stored = await driver.all<{ value_json: string }>(
      'SELECT value_json FROM custom_field_values WHERE sha256 = ? AND field_id = ?',
      [hashA, related.id],
    );
    expect(JSON.parse(stored[0]!.value_json)).toEqual([hashC]);

    // The same document uploaded again is a new document, linked to nothing.
    await storage.put(hashB, B, NOW + 1, 1);
    expect((await fields.valuesOf(hashA))[0]?.value).toEqual([hashC]);
    expect(await fields.valuesOf(hashB)).toEqual([]);
  });

  it('drops a link to a document deleted for good', async () => {
    const related = await make('Related', 'documentLink');
    await fields.setValues(hashA, [{ field: related.id, value: [hashB] }], NOW);
    await storage.trash(hashB, NOW);
    await storage.purge(hashB);
    expect((await fields.valuesOf(hashA))[0]?.value).toEqual([]);
  });
});

suite('what a value may be, by type', () => {
  const field = (type: CustomFieldType, options: string[] = []) => ({ type, options });
  const fits = (type: CustomFieldType, value: unknown, options?: string[]) =>
    customFieldValueProblem(field(type, options), value) === null;

  it('accepts null for every type: the field with no value yet', () => {
    for (const type of ['text', 'boolean', 'monetary', 'select'] as const) {
      expect(fits(type, null)).toBe(true);
    }
  });

  it('checks each type', () => {
    expect(fits('text', 'hello')).toBe(true);
    expect(fits('text', 'x'.repeat(1_001))).toBe(false);
    expect(fits('boolean', false)).toBe(true);
    expect(fits('boolean', 'false')).toBe(false);
    expect(fits('date', '2024-02-29')).toBe(true);
    expect(fits('date', '2023-02-29')).toBe(false);
    expect(fits('date', '2024-2-1')).toBe(false);
    expect(fits('url', 'https://example.com/a')).toBe(true);
    expect(fits('url', 'example.com')).toBe(false);
    expect(fits('url', 'javascript:alert(1)')).toBe(false);
    expect(fits('integer', 12)).toBe(true);
    expect(fits('integer', 1.2)).toBe(false);
    expect(fits('number', 1.25)).toBe(true);
    expect(fits('number', Number.NaN)).toBe(false);
    expect(fits('monetary', { minor: 1230, currency: 'EUR' })).toBe(true);
    expect(fits('monetary', { minor: 12.3, currency: 'EUR' })).toBe(false);
    expect(fits('monetary', { minor: 1230, currency: 'eur' })).toBe(false);
    expect(fits('documentLink', [hashA])).toBe(true);
    expect(fits('documentLink', [hashA, hashA])).toBe(false);
    expect(fits('documentLink', ['x'])).toBe(false);
    expect(fits('select', 'paid', ['open', 'paid'])).toBe(true);
    expect(fits('select', 'void', ['open', 'paid'])).toBe(false);
  });
});

suite('request bodies', () => {
  it('needs options exactly for a select', () => {
    expect(isCustomFieldBody({ name: 'A', type: 'text' })).toBe(true);
    expect(isCustomFieldBody({ name: 'A', type: 'select', options: ['x', 'y'] })).toBe(true);
    expect(isCustomFieldBody({ name: 'A', type: 'select' })).toBe(false);
    expect(isCustomFieldBody({ name: 'A', type: 'select', options: ['x', 'x'] })).toBe(false);
    expect(isCustomFieldBody({ name: 'A', type: 'text', options: ['x'] })).toBe(false);
    expect(isCustomFieldBody({ name: ' ', type: 'text' })).toBe(false);
    expect(isCustomFieldBody({ name: 'A', type: 'colour' })).toBe(false);
  });

  it('lets a patch change only the name and options', () => {
    expect(isCustomFieldPatch({ name: 'B' })).toBe(true);
    expect(isCustomFieldPatch({ type: 'text' })).toBe(false);
  });

  it('wants each field once, with a value key even when null', () => {
    expect(isCustomFieldValuesBody({ values: [{ field: 1, value: null }] })).toBe(true);
    expect(isCustomFieldValuesBody({ values: [{ field: 1 }] })).toBe(false);
    expect(
      isCustomFieldValuesBody({
        values: [
          { field: 1, value: 1 },
          { field: 1, value: 2 },
        ],
      }),
    ).toBe(false);
    expect(isCustomFieldValuesBody({ values: [{ field: 0, value: 1 }] })).toBe(false);
  });
});
