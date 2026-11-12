/** One shared connection: transactions take turns, and nothing joins one by accident. */
import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '../src/node';

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function table() {
  const driver = nodeSqliteDriver();
  await driver.exec('CREATE TABLE t (v TEXT)');
  const values = async () =>
    (await driver.all<{ v: string }>('SELECT v FROM t ORDER BY v')).map((r) => r.v);
  return { driver, values };
}

suite('transactions on the node driver', () => {
  it('keep a write made outside a transaction that later rolls back', async () => {
    const { driver, values } = await table();
    const failing = driver.transaction(async () => {
      await driver.run("INSERT INTO t VALUES ('inside')");
      await later(30);
      throw new Error('gave up');
    });
    await later(5);
    await driver.run("INSERT INTO t VALUES ('outside')");
    await expect(failing).rejects.toThrow('gave up');
    expect(await values()).toEqual(['outside']);
  });

  it('run one after another rather than failing when they overlap', async () => {
    const { driver, values } = await table();
    const first = driver.transaction(async () => {
      await later(20);
      await driver.run("INSERT INTO t VALUES ('a')");
    });
    const second = driver.transaction(async () => {
      await driver.run("INSERT INTO t VALUES ('b')");
    });
    await Promise.all([first, second]);
    expect(await values()).toEqual(['a', 'b']);
  });

  it('let a transaction started within another join it', async () => {
    const { driver, values } = await table();
    await expect(
      driver.transaction(async () => {
        await driver.transaction(() => driver.run("INSERT INTO t VALUES ('nested')"));
        throw new Error('undo all of it');
      }),
    ).rejects.toThrow();
    expect(await values()).toEqual([]);
  });

  it('undo only a nested transaction that failed, when the outer one carries on', async () => {
    const { driver, values } = await table();
    await driver.transaction(async () => {
      await driver.run("INSERT INTO t VALUES ('outer')");
      await driver
        .transaction(async () => {
          await driver.run("INSERT INTO t VALUES ('inner')");
          throw new Error('inner gave up');
        })
        .catch(() => undefined);
    });
    expect(await values()).toEqual(['outer']);
  });

  it('take turns when two nested transactions start at once, so one failing spares the other', async () => {
    const { driver, values } = await table();
    const results = await driver.transaction(() =>
      Promise.allSettled([
        driver.transaction(async () => {
          await driver.run("INSERT INTO t VALUES ('fails')");
          await later(10);
          throw new Error('first gave up');
        }),
        driver.transaction(async () => {
          await driver.run("INSERT INTO t VALUES ('kept')");
          return 'second done';
        }),
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second done' });
    expect(await values()).toEqual(['kept']);
  });

  it('let a nested transaction start one of its own', async () => {
    const { driver, values } = await table();
    await driver.transaction(() =>
      driver.transaction(() =>
        driver.transaction(() => driver.run("INSERT INTO t VALUES ('deep')")),
      ),
    );
    expect(await values()).toEqual(['deep']);
  });

  it('keep a task a transaction left running out of the next transaction', async () => {
    const { driver, values } = await table();
    await driver.transaction(async () => {
      setTimeout(() => void driver.run("INSERT INTO t VALUES ('late')"), 10);
      await driver.run("INSERT INTO t VALUES ('first')");
    });
    await expect(
      driver.transaction(async () => {
        await later(30);
        throw new Error('undo the second');
      }),
    ).rejects.toThrow();
    expect(await values()).toEqual(['first', 'late']);
  });

  it('leave nothing waiting when BEGIN itself fails', async () => {
    const { driver, values } = await table();
    await driver.exec('BEGIN');
    await expect(driver.transaction(() => Promise.resolve())).rejects.toThrow();
    await driver.exec('ROLLBACK');
    await driver.run("INSERT INTO t VALUES ('after')");
    expect(await values()).toEqual(['after']);
  });

  it('carry on after a failed transaction', async () => {
    const { driver, values } = await table();
    await expect(driver.transaction(() => Promise.reject(new Error('no')))).rejects.toThrow();
    await driver.transaction(() => driver.run("INSERT INTO t VALUES ('next')"));
    expect(await values()).toEqual(['next']);
  });
});
