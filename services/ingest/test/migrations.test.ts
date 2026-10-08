import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { MIGRATIONS, migrate, type Migration } from '../src/migrations';
import { Storage, sha256Hex } from '../src/storage';

/** A fresh database with the tables migrations build on, as `Storage.open` leaves it. */
async function storageDriver(): Promise<ReturnType<typeof nodeSqliteDriver>> {
  const driver = nodeSqliteDriver();
  await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-mig-')) });
  return driver;
}

const NOW = 1_700_000_000_000;

suite('migrate', () => {
  it('applies every migration once, in order, when storage opens', async () => {
    const driver = await storageDriver();
    const rows = await driver.all<{ id: number }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((row) => row.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(driver, NOW + 1)).toEqual([]);
  });

  it('creates the jobs and deliveries tables', async () => {
    const driver = await storageDriver();
    for (const table of ['jobs', 'deliveries']) {
      const columns = await driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
      expect(
        columns.map((c) => c.name),
        table,
      ).toContain('next_at');
    }
  });

  it('applies only what is new on a database that already has some', async () => {
    const driver = nodeSqliteDriver();
    const first: Migration = { id: 1, name: 'a', statements: ['CREATE TABLE a (x)'] };
    const second: Migration = { id: 2, name: 'b', statements: ['CREATE TABLE b (x)'] };
    expect(await migrate(driver, NOW, [first])).toEqual([1]);
    expect(await migrate(driver, NOW, [first, second])).toEqual([2]);
  });

  it('leaves nothing behind when a migration fails part-way', async () => {
    const driver = nodeSqliteDriver();
    const broken: Migration = {
      id: 1,
      name: 'broken',
      statements: ['CREATE TABLE half (x)', 'THIS IS NOT SQL'],
    };
    await expect(migrate(driver, NOW, [broken])).rejects.toThrow();

    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'",
    );
    expect(tables).toEqual([]);
    expect(await driver.all('SELECT id FROM schema_migrations')).toEqual([]);
  });

  it('refuses ids that do not increase', async () => {
    const driver = nodeSqliteDriver();
    const a: Migration = { id: 2, name: 'a', statements: [] };
    const b: Migration = { id: 2, name: 'b', statements: [] };
    await expect(migrate(driver, NOW, [a, b])).rejects.toThrow(/must increase/);
  });
});

suite('a database from before connectors', () => {
  const doc = (s: string): string =>
    sha256Hex(new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`)));

  /** Built by the pre-connector server: see test/fixtures/README.md. Never opened in place. */
  async function openFixture(): Promise<ReturnType<typeof nodeSqliteDriver>> {
    const dir = mkdtempSync(join(tmpdir(), 'sheaf-v02-'));
    const file = join(dir, 'ingest.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'v0.2-ingest.db'), file);
    const driver = nodeSqliteDriver(file);
    await Storage.open({ driver, objectsDir: join(dir, 'objects') });
    return driver;
  }

  it('carries every forwarding history into deliveries for paperless', async () => {
    const driver = await openFixture();
    const rows = await driver.all<{
      sha256: string;
      connector: string;
      state: string;
      attempts: number;
      next_at: number | null;
      task_id: string | null;
      remote_id: string | null;
      error: string | null;
      done_at: number | null;
    }>('SELECT * FROM deliveries ORDER BY attempts, state');
    const bySha = new Map(rows.map((row) => [row.sha256, row]));

    expect(rows.every((row) => row.connector === 'paperless')).toBe(true);
    expect(bySha.get(doc('sent'))).toMatchObject({ state: 'sent', task_id: 'task-sent' });
    expect(bySha.get(doc('done'))).toMatchObject({
      state: 'done',
      remote_id: '41',
      task_id: 'task-done',
      done_at: 1_700_000_000_100,
    });
    expect(bySha.get(doc('failed'))).toMatchObject({ state: 'failed', attempts: 3 });
    expect(bySha.get(doc('backing-off'))).toMatchObject({
      state: 'pending',
      attempts: 2,
      next_at: 1_700_000_005_000,
      error: 'unreachable',
    });
  });

  it('gives a document that was never forwarded no row at all', async () => {
    const driver = await openFixture();
    const rows = await driver.all('SELECT * FROM deliveries WHERE sha256 = ?', [doc('untouched')]);
    expect(rows).toEqual([]);
  });
});
