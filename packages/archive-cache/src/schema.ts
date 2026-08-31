import type { SqlDriver } from '@sheaf/store';

/**
 * Its own table, guarded the same way `services/ingest`'s storage guards columns
 * added after the first release -- `CREATE ... IF NOT EXISTS` rather than a
 * version counter -- because this is one shape, not a history of them. Deliberately
 * not part of `@sheaf/store`'s own migrations: that package is the capture log and
 * everything read off it; this is a cache of somebody else's data, with nothing in
 * common except sharing a SQLite file on the device.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS archive_cache (
     id              INTEGER PRIMARY KEY,
     title           TEXT NOT NULL,
     correspondent   TEXT,
     document_type   TEXT,
     tags            TEXT NOT NULL DEFAULT '[]',
     created         TEXT NOT NULL,
     content_snippet TEXT,
     thumbnail_path  TEXT,
     starred         INTEGER NOT NULL DEFAULT 0,
     cached_at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS archive_cache_by_recency ON archive_cache (starred, cached_at DESC)`,
];

/** Bring the cache table into existence. Safe to call on every launch. */
export async function migrateArchiveCache(driver: SqlDriver): Promise<void> {
  for (const statement of SCHEMA) await driver.exec(statement);
}
