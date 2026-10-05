/**
 * The archive the phone browses, served from the server's own catalog when there is
 * no Paperless (ADR 0007). It must look the same to the phone as the Paperless one:
 * same ids (positive integers), same shapes, same paging.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { nativeArchiveSource } from '../src/native-archive';
import type { ArchiveSource } from '../src/paperless-browse';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

let driver: NodeSqliteDriver;
let storage: Storage;
let archive: ArchiveSource;

async function store(name: string, at: number, text?: string): Promise<string> {
  const bytes = pdf(name);
  const sha256 = sha256Hex(bytes);
  await storage.put(sha256, bytes, at, 1);
  if (text !== undefined)
    await storage.putText(sha256, { source: 'edge', engine: 'mlkit', text }, at);
  return sha256;
}

const idOf = async (sha256: string): Promise<number> => (await storage.archiveIdFor(sha256))!;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-arch-')) });
  archive = nativeArchiveSource(storage);
});

suite('native archive', () => {
  it('lists documents newest first, with positive integer ids and a text excerpt', async () => {
    await store('old', T0, 'An old receipt');
    const recent = await store('new', T0 + DAY, 'A new invoice from ACME');

    const result = await archive.search({});
    expect(result.ok && result.value.documents.map((d) => d.id)).toEqual([
      await idOf(recent),
      expect.any(Number),
    ]);
    const first = result.ok ? result.value.documents[0]! : null;
    expect(first).toMatchObject({
      created: '2026-10-02',
      contentSnippet: 'A new invoice from ACME',
    });
    expect(first!.id).toBeGreaterThan(0);
  });

  it('keeps a document’s id when the database is vacuumed', async () => {
    const a = await store('a', T0);
    const b = await store('b', T0 + 1);
    const before = [await idOf(a), await idOf(b)];
    await driver.run('DELETE FROM documents WHERE sha256 = ?', [a]);
    await driver.exec('VACUUM');
    expect(await idOf(b)).toBe(before[1]);
  });

  it('searches by text and filters by the details given', async () => {
    const receipt = await store('r', T0, 'CINEMA CITY total 12.50');
    const bill = await store('b', T0 + 1, 'Electricity for September');
    await storage.patch(receipt, { correspondent: 'Cinema City', tags: ['leisure'] });
    await storage.patch(bill, {
      correspondent: 'City Power',
      documentType: 'Bill',
      tags: ['home'],
    });

    const vocabulary = await archive.vocabulary();
    const cinema = vocabulary.correspondents.find((c) => c.name === 'Cinema City')!;
    const home = vocabulary.tags.find((t) => t.name === 'home')!;

    const byText = await archive.search({ text: 'cinema' });
    expect(byText.ok && byText.value.documents.map((d) => d.id)).toEqual([await idOf(receipt)]);
    const byCorrespondent = await archive.search({ correspondentId: cinema.id });
    expect(byCorrespondent.ok && byCorrespondent.value.count).toBe(1);
    const byTag = await archive.search({ tagId: home.id });
    expect(byTag.ok && byTag.value.documents.map((d) => d.id)).toEqual([await idOf(bill)]);
    const both = await archive.search({ text: 'cinema', tagId: home.id });
    expect(both.ok && both.value.count).toBe(0);
  });

  it('pages 25 at a time and says when there are more', async () => {
    for (let i = 0; i < 30; i++) await store(`d${String(i)}`, T0 + i);
    const first = await archive.search({ page: 1 });
    const second = await archive.search({ page: 2 });
    expect(
      first.ok && [first.value.documents.length, first.value.count, first.value.hasMore],
    ).toEqual([25, 30, true]);
    expect(second.ok && [second.value.documents.length, second.value.hasMore]).toEqual([5, false]);
  });

  it('edits a document by vocabulary id, and reads back what is stored', async () => {
    const sha256 = await store('x', T0, 'some text');
    await storage.patch(await store('y', T0), { correspondent: 'ACME', tags: ['work', 'tax'] });
    const vocabulary = await archive.vocabulary();
    const acme = vocabulary.correspondents.find((c) => c.name === 'ACME')!;
    const tax = vocabulary.tags.find((t) => t.name === 'tax')!;

    const result = await archive.patch(await idOf(sha256), {
      title: 'Contract',
      correspondentId: acme.id,
      tagIds: [tax.id],
    });
    expect(result.ok && result.value).toMatchObject({
      title: 'Contract',
      correspondent: 'ACME',
      tags: ['tax'],
    });
    expect((await storage.record(sha256))!.correspondent).toBe('ACME');
  });

  it('clears a detail with null, and refuses an id it does not know', async () => {
    const sha256 = await store('z', T0);
    await storage.patch(sha256, { correspondent: 'Someone' });
    const cleared = await archive.patch(await idOf(sha256), { correspondentId: null });
    expect(cleared.ok && cleared.value.correspondent).toBeNull();

    const unknown = await archive.patch(await idOf(sha256), { correspondentId: 999 });
    expect(unknown.ok).toBe(false);
  });

  it('answers not found for an id that names nothing', async () => {
    expect(await archive.get(12345)).toEqual({ ok: false, reason: { kind: 'not_found' } });
    expect((await archive.thumbnail(1)).ok).toBe(false);
  });

  it('gives documents from before the archive existed an id, oldest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheaf-arch-old-'));
    const file = join(dir, 'ingest.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'v0.2-ingest.db'), file);
    const old = await Storage.open({ driver: nodeSqliteDriver(file), objectsDir: join(dir, 'o') });
    const listed = await nativeArchiveSource(old).search({});
    expect(listed.ok && listed.value.count).toBe(5);
    const ids = listed.ok ? listed.value.documents.map((d) => d.id) : [];
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
