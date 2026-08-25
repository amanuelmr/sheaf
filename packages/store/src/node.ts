import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './driver.ts';

/**
 * `node:sqlite` behind the driver interface.
 *
 * Deliberately a separate entry point (`@sheaf/store/node`) rather than part of the
 * barrel: React Native has no `node:sqlite`, and Metro must never be given a reason
 * to try resolving it.
 *
 * node:sqlite is synchronous and throws; the driver contract is asynchronous and
 * rejects. Converting here is what makes the two interchangeable.
 */
export interface NodeSqliteDriver extends SqlDriver {
  close(): void;
}

const settle = <T>(work: () => T): Promise<T> => {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
};

export function nodeSqliteDriver(filename = ':memory:'): NodeSqliteDriver {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    exec: (sql) => settle(() => void db.exec(sql)),
    run: (sql, params: readonly SqlValue[] = []) =>
      settle(() => void db.prepare(sql).run(...params)),
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      settle(() => db.prepare(sql).all(...params) as unknown as readonly T[]),
    transaction: async <T>(work: () => Promise<T>): Promise<T> => {
      db.exec('BEGIN');
      try {
        const result = await work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
