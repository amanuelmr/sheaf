import type { SqlDriver } from './driver';

/**
 * Schema for the capture log.
 *
 * The triggers are the point. "Append-only" as a convention lasts until someone
 * writes a well-meaning UPDATE; as a trigger it is enforced by the database, and
 * the guarantee crash recovery rests on cannot be undone by a future commit.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  // 1
  [
    `CREATE TABLE IF NOT EXISTS capture_log (
       seq     INTEGER PRIMARY KEY AUTOINCREMENT,
       doc_id  TEXT    NOT NULL,
       at      INTEGER NOT NULL,
       type    TEXT    NOT NULL,
       payload TEXT    NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS capture_log_by_doc ON capture_log (doc_id, seq)`,
    `CREATE TRIGGER IF NOT EXISTS capture_log_no_update
       BEFORE UPDATE ON capture_log
       BEGIN SELECT RAISE(ABORT, 'capture_log is append-only'); END`,
    `CREATE TRIGGER IF NOT EXISTS capture_log_no_delete
       BEFORE DELETE ON capture_log
       BEGIN SELECT RAISE(ABORT, 'capture_log is append-only'); END`,
    `CREATE TABLE IF NOT EXISTS app_settings (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring a database up to the current schema. Safe to run on every launch. */
export async function migrate(driver: SqlDriver): Promise<number> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) `);
  const rows = await driver.all<{ version: number }>('SELECT version FROM schema_version LIMIT 1');
  const current = rows[0]?.version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    for (const statement of MIGRATIONS[version]!) await driver.exec(statement);
  }

  if (current === 0) {
    await driver.run('INSERT INTO schema_version (version) VALUES (?)', [MIGRATIONS.length]);
  } else if (current < MIGRATIONS.length) {
    await driver.run('UPDATE schema_version SET version = ?', [MIGRATIONS.length]);
  }
  return MIGRATIONS.length;
}
