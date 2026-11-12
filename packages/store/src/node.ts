import { AsyncLocalStorage } from 'node:async_hooks';
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
 *
 * The whole server shares one connection, so transactions take turns: a second one
 * waits for the first to finish, and a query from outside an open transaction waits
 * too, rather than becoming part of it. Queries made by the transaction's own work
 * run inside it, and a transaction started within it is a savepoint.
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
  /**
   * Set while running a transaction's own work. Cleared when it ends, so a task the
   * work started without waiting for cannot slip into a later transaction.
   */
  const inside = new AsyncLocalStorage<{ active: boolean }>();
  /** Settles when the open transaction ends; null when none is open. */
  let open: Promise<void> | null = null;
  /** Transactions waiting their turn, in order. */
  let queue: Promise<unknown> = Promise.resolve();
  let savepoints = 0;

  const query = <T>(work: () => T): Promise<T> =>
    open === null || inside.getStore()?.active === true
      ? settle(work)
      : open.then(() => query(work));

  /** A transaction within one: a savepoint, so its failure undoes only its own writes. */
  const nested = async <T>(work: () => Promise<T>): Promise<T> => {
    const name = `sheaf_${String(++savepoints)}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = await work();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  };

  const transaction = <T>(work: () => Promise<T>): Promise<T> => {
    if (inside.getStore()?.active === true) return nested(work);
    const turn = queue.then(async () => {
      let end!: () => void;
      open = new Promise((resolve) => (end = resolve));
      const state = { active: true };
      try {
        db.exec('BEGIN');
        try {
          const result = await inside.run(state, work);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } finally {
        // Even when BEGIN itself failed: nothing may be left waiting on this one.
        state.active = false;
        open = null;
        end();
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    exec: (sql) => query(() => void db.exec(sql)),
    run: (sql, params: readonly SqlValue[] = []) =>
      query(() => void db.prepare(sql).run(...params)),
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      query(() => db.prepare(sql).all(...params) as unknown as readonly T[]),
    transaction,
    close: () => db.close(),
  };
}
