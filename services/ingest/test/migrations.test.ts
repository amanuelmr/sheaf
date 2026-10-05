import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { MIGRATIONS, migrate, type Migration } from '../src/migrations';

const NOW = 1_700_000_000_000;

suite('migrate', () => {
  it('applies every migration once, in order', async () => {
    const driver = nodeSqliteDriver();
    expect(await migrate(driver, NOW)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(driver, NOW + 1)).toEqual([]);

    const rows = await driver.all<{ id: number; applied_at: number }>(
      'SELECT id, applied_at FROM schema_migrations ORDER BY id',
    );
    expect(rows.map((row) => row.applied_at)).toEqual(MIGRATIONS.map(() => NOW));
  });

  it('creates the jobs table', async () => {
    const driver = nodeSqliteDriver();
    await migrate(driver, NOW);
    const columns = await driver.all<{ name: string }>('PRAGMA table_info(jobs)');
    expect(columns.map((c) => c.name)).toContain('next_at');
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
