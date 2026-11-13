import type { SqlDriver } from '../src/driver';

export { nodeSqliteDriver } from '../src/node';
export type { NodeSqliteDriver as TestDriver } from '../src/node';

/** Wraps a driver so the Nth write fails, to prove appends are all-or-nothing. */
export function failingAfter(driver: SqlDriver, writes: number): SqlDriver {
  const seen = { writes: 0 };
  const wrap = (inner: SqlDriver): SqlDriver => ({
    exec: (sql) => inner.exec(sql),
    all: (sql, params) => inner.all(sql, params),
    transaction: (work) => inner.transaction((tx) => work(wrap(tx))),
    run: (sql, params) => {
      seen.writes += 1;
      return seen.writes > writes ? Promise.reject(new Error('disk full')) : inner.run(sql, params);
    },
  });
  return wrap(driver);
}
