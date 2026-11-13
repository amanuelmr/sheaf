import * as SQLite from 'expo-sqlite';
import { migrateArchiveCache } from '@sheaf/archive-cache';
import { migrateOutboxOcr } from '@sheaf/outbox-ocr';
import { migrate, queuedDriver, type QueuedDriver, type SqlValue } from '@sheaf/store';

/** Closing waits its turn, so it never cuts off an append. */
export type Database = QueuedDriver;

/**
 * `expo-sqlite` behind the store's driver interface, so the schema and queries that
 * run here are the ones covered by tests against `node:sqlite`.
 *
 * WAL is not decoration. The capture log is the only record that a document exists,
 * so a commit has to survive the process dying immediately afterwards. Calls take
 * turns on the one connection, so nothing joins a transaction by accident.
 */
export async function openDatabase(name = 'sheaf.db'): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL');
  await db.execAsync('PRAGMA synchronous = FULL');

  // Not `withTransactionAsync`: Expo includes in it any query that runs while it is
  // open, from anywhere in the app, so a rollback could take an append with it.
  const driver = queuedDriver({
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params) => {
      await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
    },
    all: <T>(sql: string, params: readonly SqlValue[]) =>
      db.getAllAsync(sql, params as SQLite.SQLiteBindValue[]) as Promise<readonly T[]>,
    close: () => db.closeAsync(),
  });

  await migrate(driver);
  // Separate tables with nothing in common with the capture log except the file
  // they live in -- see ARCHITECTURE.md on why they stay apart from it.
  await migrateArchiveCache(driver);
  await migrateOutboxOcr(driver);
  return driver;
}
