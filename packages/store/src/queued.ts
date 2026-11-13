import type { SqlDriver, SqlValue } from './driver.ts';

/** A connection's own calls, with no ordering of their own. */
export interface RawSql {
  exec(sql: string): Promise<void>;
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params: readonly SqlValue[]): Promise<readonly T[]>;
  close(): Promise<void>;
}

/** The queued driver, closed in its turn so nothing is cut off halfway. */
export interface QueuedDriver extends SqlDriver {
  close(): Promise<void>;
}

/**
 * A driver over one connection where every call takes its turn, for a runtime with
 * no way to tell which transaction a query belongs to (React Native has no
 * AsyncLocalStorage). A transaction holds the connection until it ends; its work
 * queries through the driver it is handed, and any other query waits, so it can
 * never land inside a transaction that then rolls back.
 *
 * A query made inside a transaction through the outer driver would wait for that
 * transaction forever: inside, always use the one handed in.
 */
export function queuedDriver(raw: RawSql): QueuedDriver {
  let tail: Promise<unknown> = Promise.resolve();
  const turn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
  let savepoints = 0;

  const outer: QueuedDriver = {
    exec: (sql) => turn(() => raw.exec(sql)),
    run: (sql, params = []) => turn(() => raw.run(sql, params)),
    all: <T>(sql: string, params: readonly SqlValue[] = []) => turn(() => raw.all<T>(sql, params)),
    transaction: (work) =>
      turn(async () => {
        await raw.exec('BEGIN');
        return held(work, 'COMMIT', 'ROLLBACK');
      }),
    close: () => turn(() => raw.close()),
  };

  /**
   * Runs `work` with a driver straight onto the connection, already in a
   * transaction or savepoint, then ends it with `done` or undoes it with `undo`.
   * Once it ends, that driver queues like any other, so a task the work left
   * running cannot slip into whatever runs next.
   */
  async function held<T>(
    work: (tx: SqlDriver) => Promise<T>,
    done: string,
    undo: string | readonly string[],
  ): Promise<T> {
    let open = true;
    // Savepoints started within this one take turns, as rolling one back would undo
    // a sibling's writes too.
    let inner: Promise<unknown> = Promise.resolve();
    const direct = <R>(call: () => Promise<R>, queued: () => Promise<R>) =>
      open ? call() : queued();
    const tx: SqlDriver = {
      exec: (sql) =>
        direct(
          () => raw.exec(sql),
          () => outer.exec(sql),
        ),
      run: (sql, params = []) =>
        direct(
          () => raw.run(sql, params),
          () => outer.run(sql, params),
        ),
      all: <R>(sql: string, params: readonly SqlValue[] = []) =>
        direct(
          () => raw.all<R>(sql, params),
          () => outer.all<R>(sql, params),
        ),
      transaction: <R>(nested: (tx: SqlDriver) => Promise<R>) => {
        if (!open) return outer.transaction(nested);
        const next = inner.then(async () => {
          const name = `sheaf_${String(++savepoints)}`;
          await raw.exec(`SAVEPOINT ${name}`);
          return held(nested, `RELEASE ${name}`, [`ROLLBACK TO ${name}`, `RELEASE ${name}`]);
        });
        inner = next.catch(() => undefined);
        return next;
      },
    };
    // Nested transactions the work started but left running end before this one
    // does; after that, anything else it left running queues.
    const close = async () => {
      let seen: Promise<unknown>;
      do {
        seen = inner;
        await seen;
      } while (seen !== inner);
      open = false;
    };
    let result: T;
    try {
      result = await work(tx);
    } catch (error) {
      await close();
      await undoAll(undo);
      throw error;
    }
    await close();
    try {
      await raw.exec(done);
    } catch (error) {
      await undoAll(undo);
      throw error;
    }
    return result;
  }

  /**
   * Each undo step runs even if one before it fails: SQLite may have rolled back on
   * its own (a full disk, an I/O error), and then the error worth reporting is the
   * one that caused it, not "no transaction is active".
   */
  async function undoAll(undo: string | readonly string[]) {
    for (const sql of typeof undo === 'string' ? [undo] : undo) {
      try {
        await raw.exec(sql);
      } catch {
        // Already undone; the caller rethrows the cause.
      }
    }
  }

  return outer;
}
