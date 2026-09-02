import * as SQLite from 'expo-sqlite';
import { migrateArchiveCache } from '@sheaf/archive-cache';
import { migrateOutboxOcr } from '@sheaf/outbox-ocr';
import { migrate, type SqlDriver, type SqlValue } from '@sheaf/store';

export interface Database extends SqlDriver {
  close(): Promise<void>;
}

/**
 * `expo-sqlite` behind the store's driver interface, so the schema and queries that
 * run here are the ones covered by tests against `node:sqlite`.
 *
 * WAL is not decoration. The capture log is the only record that a document exists,
 * so a commit has to survive the process dying immediately afterwards.
 */
export async function openDatabase(name = 'sheaf.db'): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL');
  await db.execAsync('PRAGMA synchronous = FULL');

  const driver: Database = {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: readonly SqlValue[] = []) => {
      await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
    },
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      db.getAllAsync(sql, params as SQLite.SQLiteBindValue[]) as Promise<readonly T[]>,
    transaction: async <T>(work: () => Promise<T>): Promise<T> => {
      let result: T | undefined;
      let captured = false;
      await db.withTransactionAsync(async () => {
        result = await work();
        captured = true;
      });
      if (!captured) throw new Error('transaction did not complete');
      return result as T;
    },
    close: () => db.closeAsync(),
  };

  await migrate(driver);
  // Separate tables with nothing in common with the capture log except the file
  // they live in -- see ARCHITECTURE.md on why they stay apart from it.
  await migrateArchiveCache(driver);
  await migrateOutboxOcr(driver);
  return driver;
}
