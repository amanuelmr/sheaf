/**
 * The trash: deleting hides a document everywhere at once without losing it, a
 * restore brings all of it back, and only what sat in the trash long enough is
 * ever deleted for good.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { isTrashActionBody } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { trashFromEnv } from '../src/config';
import { nativeArchiveSource } from '../src/native-archive';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';
import { TrashSweeper } from '../src/trash';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const A = pdf('a');
const B = pdf('b');
const hashA = sha256Hex(A);
const hashB = sha256Hex(B);
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let driver: SqlDriver;
let storage: Storage;
let objectsDir: string;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  objectsDir = mkdtempSync(join(tmpdir(), 'sheaf-trash-'));
  storage = await Storage.open({ driver, objectsDir });
  await storage.put(hashA, A, NOW, 1);
  await storage.put(hashB, B, NOW + 1, 1);
  await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: 'cinema ticket' }, NOW);
});

const find = async (q: string): Promise<string[]> =>
  (await storage.search(toMatch(q)!, 20, 0)).hits.map((hit) => hit.sha256);

suite('moving a document to the trash', () => {
  it('hides it from the list, the count, search and the archive', async () => {
    expect(await storage.trash(hashA, NOW + 10)).toBe(true);

    expect((await storage.list()).map((d) => d.sha256)).toEqual([hashB]);
    expect(await storage.count()).toBe(1);
    expect(await find('cinema')).toEqual([]);
    const archive = nativeArchiveSource(storage);
    const page = await archive.search({});
    expect(page.ok && page.value.documents.length).toBe(1);
  });

  it('keeps the bytes and the record, which says when it was trashed', async () => {
    await storage.trash(hashA, NOW + 10);
    expect(storage.bytes(hashA)).not.toBeNull();
    expect((await storage.record(hashA))?.trashedAt).toBe(NOW + 10);
    expect((await storage.record(hashB))?.trashedAt).toBeUndefined();
  });

  it('keeps the first time when trashed twice', async () => {
    await storage.trash(hashA, NOW + 10);
    await storage.trash(hashA, NOW + 20);
    expect((await storage.trashed()).map((e) => e.trashedAt)).toEqual([NOW + 10]);
  });

  it('does not forward a trashed document', async () => {
    await storage.trash(hashA, NOW + 10);
    const due = await storage.dueForForwarding(NOW + 100, 'paperless');
    expect(due.map((d) => d.sha256)).toEqual([hashB]);
  });

  it('answers false for a document it never had', async () => {
    expect(await storage.trash(sha256Hex(pdf('nope')), NOW)).toBe(false);
  });
});

suite('restoring', () => {
  it('brings a document back everywhere, searchable again', async () => {
    await storage.trash(hashA, NOW + 10);
    expect(await storage.restore([hashA])).toBe(1);
    expect(await find('cinema')).toEqual([hashA]);
    expect(await storage.count()).toBe(2);
    expect((await storage.record(hashA))?.trashedAt).toBeUndefined();
  });

  it('counts only documents that were in the trash', async () => {
    await storage.trash(hashA, NOW + 10);
    expect(await storage.restore([hashA, hashB, sha256Hex(pdf('nope'))])).toBe(1);
  });

  it('lets work that waited in the trash go ahead at once', async () => {
    await driver.run(
      `INSERT INTO jobs (sha256, step, version, state, attempts, next_at, created_at)
       VALUES (?, 'extract', 1, 'pending', 0, ?, ?)`,
      [hashA, NOW + DAY, NOW],
    );
    await storage.trash(hashA, NOW + 10);
    await storage.restore([hashA]);
    const rows = await driver.all<{ next_at: number | null }>(
      'SELECT next_at FROM jobs WHERE sha256 = ?',
      [hashA],
    );
    expect(rows[0]?.next_at).toBeNull();
  });
});

suite('deleting for good', () => {
  it('removes the file and every row, but only for a trashed document', async () => {
    await storage.addNote(hashA, 'a note', null, NOW);
    expect(await storage.purge(hashA)).toBe(false);

    await storage.trash(hashA, NOW + 10);
    expect(await storage.purge(hashA)).toBe(true);
    expect(await storage.has(hashA)).toBe(false);
    expect(storage.bytes(hashA)).toBeNull();
    for (const table of ['document_text', 'notes', 'documents_fts']) {
      const rows = await driver.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE sha256 = ?`,
        [hashA],
      );
      expect(rows[0]?.n).toBe(0);
    }
    expect(await storage.purge(hashA)).toBe(false);
  });

  it('keeps the archive id, so it never comes to name another document', async () => {
    const id = await storage.archiveIdFor(hashA);
    await storage.trash(hashA, NOW + 10);
    await storage.purge(hashA);
    expect(await storage.archiveIdFor(hashA)).toBe(id);
    expect(await storage.archiveRow(id!)).toBeNull();
  });

  it('can store the same document again afterwards', async () => {
    await storage.trash(hashA, NOW + 10);
    await storage.purge(hashA);
    expect(await storage.put(hashA, A, NOW + 20, 1)).toBe('stored');
    expect(existsSync(join(objectsDir, hashA.slice(0, 2), `${hashA}.pdf`))).toBe(true);
  });
});

suite('the sweeper', () => {
  it('deletes only what has been in the trash long enough', async () => {
    await storage.trash(hashA, NOW);
    await storage.trash(hashB, NOW + 5 * DAY);
    let clock = NOW + 30 * DAY;
    const sweeper = new TrashSweeper(storage, 30 * DAY, { now: () => clock });

    expect(await sweeper.tick()).toEqual({ purged: 1 });
    expect(await storage.has(hashA)).toBe(false);
    expect(await storage.has(hashB)).toBe(true);

    clock += 5 * DAY;
    expect(await sweeper.tick()).toEqual({ purged: 1 });
    expect(readdirSync(objectsDir).flatMap((d) => readdirSync(join(objectsDir, d)))).toEqual([]);
  });

  it('never touches a document that is not in the trash', async () => {
    const sweeper = new TrashSweeper(storage, 0, { now: () => NOW + 1000 * DAY });
    expect(await sweeper.tick()).toEqual({ purged: 0 });
    expect(await storage.count()).toBe(2);
  });
});

suite('SHEAF_TRASH_DAYS', () => {
  it('defaults, accepts whole and fractional days, and refuses less than one', () => {
    expect(trashFromEnv({}, 30)).toEqual({ kind: 'on', days: 30 });
    expect(trashFromEnv({ SHEAF_TRASH_DAYS: '7' }, 30)).toEqual({ kind: 'on', days: 7 });
    expect(trashFromEnv({ SHEAF_TRASH_DAYS: '1.5' }, 30)).toEqual({ kind: 'on', days: 1.5 });
    for (const bad of ['0', '-3', 'soon', '0.5']) {
      expect(trashFromEnv({ SHEAF_TRASH_DAYS: bad }, 30).kind).toBe('invalid');
    }
  });
});

suite('what a trash action body may be', () => {
  it('is an object with, optionally, a list of document ids', () => {
    expect(isTrashActionBody({})).toBe(true);
    expect(isTrashActionBody({ documents: [hashA] })).toBe(true);
    expect(isTrashActionBody({ documents: ['../etc'] })).toBe(false);
    expect(isTrashActionBody({ documents: hashA })).toBe(false);
    expect(isTrashActionBody([])).toBe(false);
  });
});
