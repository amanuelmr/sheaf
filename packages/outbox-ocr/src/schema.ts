import type { SqlDriver } from '@sheaf/store';

/**
 * Its own table, guarded the same way `@sheaf/archive-cache` guards its own --
 * `CREATE ... IF NOT EXISTS` rather than a version counter, because this is one
 * shape, not a history of them. Deliberately not part of `@sheaf/store`'s own
 * migrations: that package is the capture log and everything read off it; this
 * is a phone-side reading of a document *this phone* captured, with nothing in
 * common except sharing a SQLite file on the device.
 *
 * No eviction cap, unlike `archive_cache`: a row here is removed the moment its
 * document is released (synced and no longer needed locally), so the table is
 * self-bounding -- it can never hold more text than the outbox itself holds
 * documents.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS outbox_ocr (
     doc_id       TEXT PRIMARY KEY,
     text         TEXT NOT NULL,
     extracted_at INTEGER NOT NULL
   )`,
];

/** Bring the table into existence. Safe to call on every launch. */
export async function migrateOutboxOcr(driver: SqlDriver): Promise<void> {
  for (const statement of SCHEMA) await driver.exec(statement);
}
