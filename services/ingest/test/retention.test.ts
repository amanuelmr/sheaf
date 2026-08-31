/**
 * Retention is the third and separate decision, after "store it" and "forward it":
 * whether to eventually free the bytes for a document Paperless has already
 * confirmed. The properties that matter mirror the caution the rest of the project
 * applies to deleting anything -- it must never act on a document that is not
 * `'done'`, never act before its own grace period, and never lose the row (and
 * therefore the metadata and the forwarding history) when it does act.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Retention } from '../src/retention';
import { Storage, sha256Hex } from '../src/storage';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nretain me\n%%EOF\n'));
const hashA = sha256Hex(A);
const DAY = 24 * 60 * 60 * 1000;

let storage: Storage;
let clock: number;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-retain-')),
  });
  await storage.put(hashA, A, clock, 1);
});

async function markDone(): Promise<void> {
  await storage.recordForwardAttempt(hashA, {
    state: 'done',
    attempts: 1,
    nextAt: null,
    remoteId: '4821',
    error: null,
    doneAt: clock,
  });
}

suite('what becomes due', () => {
  it('leaves a document alone until forwarding has finished', async () => {
    const retention = new Retention(storage, DAY, { now: () => clock + 10 * DAY });
    expect((await retention.tick()).released).toBe(0);
    expect(storage.bytes(hashA)).toEqual(A);
  });

  it('leaves a done document alone before its grace period is up', async () => {
    await markDone();
    const retention = new Retention(storage, DAY, { now: () => clock + DAY / 2 });
    expect((await retention.tick()).released).toBe(0);
    expect(storage.bytes(hashA)).toEqual(A);
  });

  it('frees the bytes once a done document has aged past the grace period', async () => {
    await markDone();
    const retention = new Retention(storage, DAY, { now: () => clock + DAY + 1 });
    expect((await retention.tick()).released).toBe(1);
    expect(storage.bytes(hashA)).toBeNull();
  });
});

suite('what survives', () => {
  it('keeps the row, the metadata, and the forwarding history', async () => {
    await markDone();
    await storage.patch(hashA, { title: 'Amazon receipt', tags: ['shopping'] });
    const retention = new Retention(storage, DAY, { now: () => clock + DAY + 1 });
    await retention.tick();

    const record = await storage.record(hashA);
    expect(record?.title).toBe('Amazon receipt');
    expect(record?.forward.state).toBe('done');
    expect(record?.forward.remoteId).toBe('4821');
    expect(record?.bytesReleased).toBe(true);
  });

  it('is idempotent: a second pass finds nothing left to do', async () => {
    await markDone();
    const retention = new Retention(storage, DAY, { now: () => clock + DAY + 1 });
    await retention.tick();
    expect((await retention.tick()).released).toBe(0);
  });

  it('tolerates being asked to release a file that is already gone from disk', async () => {
    await markDone();
    await storage.release(hashA); // released once already, by hand
    // The file is gone but the row is not -- a crash between unlinking and
    // recording that should not turn the next pass's retry into a crash too.
    await expect(storage.release(hashA)).resolves.toBeUndefined();
  });
});

suite('storage.dueForRelease', () => {
  it('only ever returns documents that are done and not yet released', async () => {
    const B = new Uint8Array(Buffer.from('%PDF-1.4\nsecond\n%%EOF\n'));
    const hashB = sha256Hex(B);
    await storage.put(hashB, B, clock, 1);
    await markDone(); // A only

    const due = await storage.dueForRelease(clock + 10 * DAY, DAY);
    expect(due.map((d) => d.sha256)).toEqual([hashA]);
  });

  it('orders the oldest completion first', async () => {
    const B = new Uint8Array(Buffer.from('%PDF-1.4\nsecond\n%%EOF\n'));
    const hashB = sha256Hex(B);
    await storage.put(hashB, B, clock, 1);
    await storage.recordForwardAttempt(hashB, {
      state: 'done',
      attempts: 1,
      nextAt: null,
      error: null,
      doneAt: clock - DAY,
    });
    await markDone(); // finished a day later than B

    const due = await storage.dueForRelease(clock + 10 * DAY, DAY);
    expect(due.map((d) => d.sha256)).toEqual([hashB, hashA]);
  });
});

suite('the file on disk', () => {
  it('is actually removed, not just forgotten about', async () => {
    const objectsDir = mkdtempSync(join(tmpdir(), 'sheaf-retain-fs-'));
    const local = await Storage.open({ driver: nodeSqliteDriver(), objectsDir });
    await local.put(hashA, A, clock, 1);
    const path = join(objectsDir, hashA.slice(0, 2), `${hashA}.pdf`);
    expect(existsSync(path)).toBe(true);

    await local.recordForwardAttempt(hashA, {
      state: 'done',
      attempts: 1,
      nextAt: null,
      error: null,
      doneAt: clock,
    });
    await local.release(hashA);
    expect(existsSync(path)).toBe(false);
  });
});
