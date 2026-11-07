/** One change to many documents, made as a person editing each would make it. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { BulkEditor } from '../src/bulk';
import { CustomFields } from '../src/custom-fields';
import { Labels } from '../src/labels';
import { handle, type IngestRequest } from '../src/router';
import { Rules } from '../src/rules';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const NOW = 1_700_000_000_000;
const TOKEN = 'admin-token-for-bulk';

let storage: Storage;
let fields: CustomFields;
let bulk: BulkEditor;
let labels: Labels;

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-bk-')) });
  fields = new CustomFields(driver, storage);
  labels = new Labels(driver, storage);
  bulk = new BulkEditor(storage, fields, new Rules(driver, storage));
  for (const [hash, bytes] of [
    [hashA, A],
    [hashB, B],
    [hashC, C],
  ] as const) {
    await storage.put(hash, bytes, NOW, 1);
  }
  await storage.patch(hashA, { tags: ['bills', 'unread'] }, NOW);
  await storage.patch(hashB, { tags: ['unread'], correspondent: 'Water Co' }, NOW);
});

suite('bulk edits', () => {
  it('sets a correspondent, counting only documents it changed, and records it as chosen', async () => {
    const result = await bulk.edit(
      [hashA, hashB, hashC],
      { kind: 'setCorrespondent', value: 'Water Co' },
      NOW,
    );
    expect(result).toEqual({ ok: true, changed: 2 });
    expect((await storage.record(hashA))?.correspondent).toBe('Water Co');
    const field = (await storage.fields(hashA)).find((f) => f.name === 'correspondent');
    expect(field?.source).toBe('user');
    expect((await labels.list('correspondent')).map((l) => [l.name, l.documents])).toEqual([
      ['Water Co', 3],
    ]);
  });

  it('adds and removes tags together, keeping their order', async () => {
    const result = await bulk.edit(
      [hashA, hashB, hashC],
      { kind: 'modifyTags', add: ['home'], remove: ['unread'] },
      NOW,
    );
    expect(result).toEqual({ ok: true, changed: 3 });
    expect((await storage.record(hashA))?.tags).toEqual(['bills', 'home']);
    expect((await storage.record(hashB))?.tags).toEqual(['home']);
    expect((await storage.record(hashC))?.tags).toEqual(['home']);
  });

  it('clears a document type, and moves documents to the trash', async () => {
    await storage.patch(hashC, { documentType: 'Invoice' }, NOW);
    expect(await bulk.edit([hashC], { kind: 'setDocumentType', value: null }, NOW)).toEqual({
      ok: true,
      changed: 1,
    });
    expect(await bulk.edit([hashA, hashB], { kind: 'trash' }, NOW)).toEqual({
      ok: true,
      changed: 2,
    });
    expect(await storage.count()).toBe(1);
    expect(await bulk.edit([hashA], { kind: 'trash' }, NOW)).toEqual({ ok: true, changed: 0 });
  });

  it('sets and removes a custom field, leaving the others alone', async () => {
    const due = await fields.create({ name: 'Due', type: 'date' }, NOW);
    const note = await fields.create({ name: 'Ref', type: 'text' }, NOW);
    if (!due.ok || !note.ok) throw new Error('no fields');
    await fields.setValues(hashA, [{ field: note.value.id, value: 'keep me' }], NOW);

    const set = await bulk.edit(
      [hashA, hashB],
      { kind: 'setCustomField', field: due.value.id, value: '2026-12-01' },
      NOW,
    );
    expect(set).toEqual({ ok: true, changed: 2 });
    expect((await fields.valuesOf(hashA)).map((v) => [v.name, v.value])).toEqual([
      ['Due', '2026-12-01'],
      ['Ref', 'keep me'],
    ]);
    const removed = await bulk.edit(
      [hashA, hashC],
      { kind: 'removeCustomField', field: due.value.id },
      NOW,
    );
    expect(removed).toEqual({ ok: true, changed: 1 });
    expect((await fields.valuesOf(hashA)).map((v) => v.name)).toEqual(['Ref']);
  });

  it('refuses a value that does not fit the field before touching anything', async () => {
    const count = await fields.create({ name: 'Count', type: 'integer' }, NOW);
    if (!count.ok) throw new Error('no field');
    const refused = await bulk.edit(
      [hashA, hashB],
      { kind: 'setCustomField', field: count.value.id, value: 'many' },
      NOW,
    );
    expect(refused.ok).toBe(false);
    expect(await fields.valuesOf(hashA)).toEqual([]);
    expect((await bulk.edit([hashA], { kind: 'removeCustomField', field: 999 }, NOW)).ok).toBe(
      false,
    );
  });

  it('is served at POST /v1/documents/bulk', async () => {
    const deps = { storage, token: TOKEN, now: () => NOW, bulk };
    const req = (body: unknown): IngestRequest => ({
      method: 'POST',
      path: paths.bulkEdit(),
      query: '',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array(Buffer.from(JSON.stringify(body))),
    });
    const done = await handle(
      req({ documents: [hashA, hashB], action: { kind: 'modifyTags', add: ['x'], remove: [] } }),
      deps,
    );
    expect(done).toMatchObject({ status: 200, json: { changed: 2 } });
    expect((await handle(req({ documents: [hashA], action: { kind: 'nope' } }), deps)).status).toBe(
      400,
    );
  });
});
