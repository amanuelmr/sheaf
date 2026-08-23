import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../src/driver';

/**
 * `node:sqlite` behind the same driver interface `expo-sqlite` will implement, so
 * the schema and queries under test are the ones that ship.
 *
 * node:sqlite is synchronous and throws; the driver contract is asynchronous and
 * rejects. Converting here rather than letting synchronous throws escape is what
 * makes the two interchangeable.
 */
export interface TestDriver extends SqlDriver {
  close(): void;
}

const settle = <T>(work: () => T): Promise<T> => {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
};

export function nodeDriver(): TestDriver {
  const db = new DatabaseSync(':memory:');
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

/** Wraps a driver so the Nth write fails, to prove appends are all-or-nothing. */
export function failingAfter(driver: SqlDriver, writes: number): SqlDriver {
  let seen = 0;
  return {
    exec: (sql) => driver.exec(sql),
    all: (sql, params) => driver.all(sql, params),
    transaction: (work) => driver.transaction(work),
    run: (sql, params) => {
      seen += 1;
      return seen > writes ? Promise.reject(new Error('disk full')) : driver.run(sql, params);
    },
  };
}
