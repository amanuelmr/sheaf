import type { SqlDriver } from '../src/driver';

export { nodeSqliteDriver } from '../src/node';
export type { NodeSqliteDriver as TestDriver } from '../src/node';

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
