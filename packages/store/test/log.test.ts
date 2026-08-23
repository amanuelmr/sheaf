import { describe as suite, beforeEach, expect, it } from 'vitest';
import { reduce } from '@sheaf/core';
import { migrate, SCHEMA_VERSION } from '../src/schema';
import { SqlEventLog } from '../src/sql-log';
import { MemoryEventLog } from '../src/memory-log';
import type { EventLog } from '../src/log';
import { failingAfter, nodeDriver, type TestDriver } from './node-driver';
import { DOC_A, DOC_B, fullLife } from './events';

/**
 * Both implementations are held to the same behaviour. If the SQL one ever drifts
 * from the in-memory one the simulator has been proving things about, this fails.
 */
const implementations: Array<[string, () => Promise<EventLog>]> = [
  ['MemoryEventLog', () => Promise.resolve(new MemoryEventLog())],
  [
    'SqlEventLog',
    async () => {
      const driver = nodeDriver();
      await migrate(driver);
      return new SqlEventLog(driver);
    },
  ],
];

for (const [name, make] of implementations) {
  suite(name, () => {
    let log: EventLog;
    beforeEach(async () => {
      log = await make();
    });

    it('round-trips every event type without losing a field', async () => {
      const events = fullLife();
      await log.append(events);
      expect(await log.replay(DOC_A)).toEqual(events);
    });

    it('preserves append order, which replay depends on', async () => {
      const events = fullLife();
      for (const event of events) await log.append([event]);
      expect((await log.replay(DOC_A)).map((e) => e.at)).toEqual(events.map((e) => e.at));
    });

    it('keeps documents apart', async () => {
      await log.append(fullLife(DOC_A));
      await log.append(fullLife(DOC_B).slice(0, 3));
      expect(await log.replay(DOC_A)).toHaveLength(14);
      expect(await log.replay(DOC_B)).toHaveLength(3);
      expect(await log.docIds()).toEqual([DOC_A, DOC_B]);
    });

    it('reports an unknown document as empty rather than failing', async () => {
      expect(await log.replay('nope')).toEqual([]);
      expect(await log.docIds()).toEqual([]);
      expect(await log.count()).toBe(0);
    });

    it('streams appends after a known point', async () => {
      await log.append(fullLife().slice(0, 3));
      const first = await log.since(0);
      expect(first).toHaveLength(3);
      await log.append(fullLife().slice(3, 5));
      const later = await log.since(first[first.length - 1]!.seq);
      expect(later.map((r) => r.event.type)).toEqual(['PageRemoved', 'Enqueued']);
    });

    it('appending nothing is a no-op, not an error', async () => {
      await log.append([]);
      expect(await log.count()).toBe(0);
    });

    it('replays into the state the engine expects', async () => {
      await log.append(fullLife());
      const state = reduce(await log.replay(DOC_A));
      expect(state.status).toBe('SYNCED');
      expect(state.remoteId).toBe(4821);
      expect(state.localFilesPresent).toBe(false);
    });
  });
}

suite('SqlEventLog durability', () => {
  let driver: TestDriver;
  beforeEach(async () => {
    driver = nodeDriver();
    await migrate(driver);
  });

  it('migrates idempotently, so every launch can just run it', async () => {
    expect(await migrate(driver)).toBe(SCHEMA_VERSION);
    expect(await migrate(driver)).toBe(SCHEMA_VERSION);
    const rows = await driver.all<{ version: number }>('SELECT version FROM schema_version');
    expect(rows).toEqual([{ version: SCHEMA_VERSION }]);
  });

  it('refuses to let anything update the log', async () => {
    const log = new SqlEventLog(driver);
    await log.append(fullLife().slice(0, 1));
    await expect(
      driver.run('UPDATE capture_log SET type = ? WHERE seq = 1', ['Tampered']),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to let anything delete from the log', async () => {
    const log = new SqlEventLog(driver);
    await log.append(fullLife().slice(0, 1));
    await expect(driver.run('DELETE FROM capture_log WHERE seq = 1', [])).rejects.toThrow(
      /append-only/,
    );
    expect(await log.count()).toBe(1);
  });

  it('appends a batch atomically, so a kill mid-write leaves no partial document', async () => {
    const events = fullLife();
    const brittle = new SqlEventLog(failingAfter(driver, 3));
    await expect(brittle.append(events)).rejects.toThrow(/disk full/);
    // Either all of it or none of it. Never half an event, never half a batch.
    expect(await new SqlEventLog(driver).count()).toBe(0);
  });

  it('survives being reopened, which is the whole point of it being on disk', async () => {
    const log = new SqlEventLog(driver);
    await log.append(fullLife());
    // A fresh log object over the same database sees everything.
    const reopened = new SqlEventLog(driver);
    expect(await reopened.replay(DOC_A)).toHaveLength(14);
    expect(reduce(await reopened.replay(DOC_A)).status).toBe('SYNCED');
  });
});
