/** Filtering documents by label, date and custom field, with or without words. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { DocumentFilter } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const JAN = Date.parse('2026-01-15T10:00:00Z');
const FEB = Date.parse('2026-02-15T10:00:00Z');
const MAR = Date.parse('2026-03-31T23:00:00Z');

let driver: SqlDriver;
let storage: Storage;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-ft-')) });
  await storage.put(hashA, A, JAN, 1);
  await storage.put(hashB, B, FEB, 1);
  await storage.put(hashC, C, MAR, 1);
  await storage.patch(hashA, {
    title: 'Power bill',
    correspondent: 'City Power',
    documentType: 'Invoice',
    tags: ['bills', 'home'],
  });
  await storage.patch(hashB, {
    title: 'Water bill',
    correspondent: 'Water Co',
    documentType: 'Invoice',
    tags: ['bills', 'paid'],
  });
  await storage.patch(hashC, { title: 'apartment lease', tags: ['home'] });
  await storage.putText(hashB, { source: 'edge', engine: 'x', text: 'quarterly water usage' }, FEB);
});

const ids = async (filter: DocumentFilter, text?: string) =>
  (await storage.find(text === undefined ? null : toMatch(text), filter, 20, 0)).hits.map(
    (hit) => hit.sha256,
  );

suite('filtering documents', () => {
  it('lists everything newest first with no filter at all', async () => {
    expect(await ids({})).toEqual([hashC, hashB, hashA]);
  });

  it('keeps documents with any of the correspondents or types', async () => {
    expect(await ids({ correspondents: ['City Power', 'Water Co'] })).toEqual([hashB, hashA]);
    expect(await ids({ documentTypes: ['Invoice'], correspondents: ['Water Co'] })).toEqual([
      hashB,
    ]);
  });

  it('needs every tag in tags, one in anyTags, and none in notTags', async () => {
    expect(await ids({ tags: ['bills', 'home'] })).toEqual([hashA]);
    expect(await ids({ anyTags: ['paid', 'home'] })).toEqual([hashC, hashB, hashA]);
    expect(await ids({ tags: ['bills'], notTags: ['paid'] })).toEqual([hashA]);
  });

  it('takes whole days in UTC, both ends included', async () => {
    expect(await ids({ receivedFrom: '2026-02-15' })).toEqual([hashC, hashB]);
    expect(await ids({ receivedTo: '2026-03-31' })).toEqual([hashC, hashB, hashA]);
    expect(await ids({ receivedFrom: '2026-01-16', receivedTo: '2026-03-30' })).toEqual([hashB]);
  });

  it('keeps documents carrying a custom field', async () => {
    const fields = new CustomFields(driver, storage);
    const made = await fields.create({ name: 'Due', type: 'date' }, JAN);
    if (!made.ok) throw new Error('no field');
    await fields.setValues(hashC, [{ field: made.value.id, value: null }], JAN);
    expect(await ids({ fields: [made.value.id] })).toEqual([hashC]);
  });

  it('combines a filter with words, keeping the snippet', async () => {
    const found = await storage.find(toMatch('water'), { tags: ['paid'] }, 20, 0);
    expect(found.hits.map((h) => h.sha256)).toEqual([hashB]);
    expect(found.hits[0]?.snippet).toMatch(/«water»/i);
    expect(await ids({ tags: ['home'] }, 'water')).toEqual([]);
  });

  it('sorts by title, oldest or newest, and counts across pages', async () => {
    expect(await ids({ sort: 'title' })).toEqual([hashC, hashA, hashB]);
    expect(await ids({ sort: 'oldest' })).toEqual([hashA, hashB, hashC]);
    const page = await storage.find(null, { tags: ['bills'] }, 1, 1);
    expect(page).toMatchObject({ total: 2, hasMore: false });
    expect(page.hits.map((h) => h.sha256)).toEqual([hashA]);
  });

  it('leaves the trash out', async () => {
    await storage.trash(hashC, MAR);
    expect(await ids({ tags: ['home'] })).toEqual([hashA]);
  });
});
