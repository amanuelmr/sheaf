/** The phone's driver: one connection, every call in turn, nothing joins by accident. */
import { DatabaseSync } from 'node:sqlite';
import { describe as suite, expect, it } from 'vitest';
import { queuedDriver } from '../src/queued';
import type { SqlValue } from '../src/driver';

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** node:sqlite made to answer a tick later, as a native call on the phone does. */
async function table() {
  const db = new DatabaseSync(':memory:');
  const tick = <T>(work: () => T) => later(1).then(work);
  const driver = queuedDriver({
    exec: (sql) => tick(() => void db.exec(sql)),
    run: (sql, params: readonly SqlValue[]) => tick(() => void db.prepare(sql).run(...params)),
    all: <T>(sql: string, params: readonly SqlValue[]) =>
      tick(() => db.prepare(sql).all(...params) as unknown as readonly T[]),
  });
  await driver.exec('CREATE TABLE t (v TEXT)');
  const values = async () =>
    (await driver.all<{ v: string }>('SELECT v FROM t ORDER BY v')).map((r) => r.v);
  return { db, driver, values };
}

suite('the queued driver', () => {
  it('keeps a write made elsewhere while a transaction is open that then rolls back', async () => {
    const { driver, values } = await table();
    const failing = driver.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('inside')");
      await later(20);
      throw new Error('gave up');
    });
    await later(5);
    await driver.run("INSERT INTO t VALUES ('outside')");
    await expect(failing).rejects.toThrow('gave up');
    expect(await values()).toEqual(['outside']);
  });

  it('runs overlapping transactions one after the other', async () => {
    const { driver, values } = await table();
    await Promise.all([
      driver.transaction(async (tx) => {
        await later(10);
        await tx.run("INSERT INTO t VALUES ('a')");
      }),
      driver.transaction((tx) => tx.run("INSERT INTO t VALUES ('b')")),
    ]);
    expect(await values()).toEqual(['a', 'b']);
  });

  it('undoes only a nested transaction that failed', async () => {
    const { driver, values } = await table();
    await driver.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('outer')");
      await tx
        .transaction(async (inner) => {
          await inner.run("INSERT INTO t VALUES ('inner')");
          throw new Error('inner gave up');
        })
        .catch(() => undefined);
    });
    expect(await values()).toEqual(['outer']);
  });

  it('makes nested transactions started at once take turns', async () => {
    const { driver, values } = await table();
    const results = await driver.transaction((tx) =>
      Promise.allSettled([
        tx.transaction(async (inner) => {
          await inner.run("INSERT INTO t VALUES ('fails')");
          await later(10);
          throw new Error('first gave up');
        }),
        tx.transaction((inner) => inner.run("INSERT INTO t VALUES ('kept')")),
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(await values()).toEqual(['kept']);
  });

  it('keeps a task a transaction left running out of the next one', async () => {
    const { driver, values } = await table();
    await driver.transaction(async (tx) => {
      setTimeout(() => void tx.run("INSERT INTO t VALUES ('late')"), 5);
      await tx.run("INSERT INTO t VALUES ('first')");
    });
    await expect(
      driver.transaction(async () => {
        await later(30);
        throw new Error('undo the second');
      }),
    ).rejects.toThrow();
    expect(await values()).toEqual(['first', 'late']);
  });

  it('carries on after BEGIN itself fails', async () => {
    const { db, driver, values } = await table();
    db.exec('BEGIN');
    await expect(driver.transaction(() => Promise.resolve())).rejects.toThrow();
    db.exec('ROLLBACK');
    await driver.transaction((tx) => tx.run("INSERT INTO t VALUES ('after')"));
    expect(await values()).toEqual(['after']);
  });
});
