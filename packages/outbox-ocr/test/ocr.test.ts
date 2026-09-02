import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { get, migrateOutboxOcr, remove, save, search } from '../src/index';

let driver: NodeSqliteDriver;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  await migrateOutboxOcr(driver);
});

suite('saving recognised text', () => {
  it('round-trips what was saved', async () => {
    await save(driver, 'doc-a', 'Amazon receipt for one widget', 1_000);
    expect(await get(driver, 'doc-a')).toBe('Amazon receipt for one widget');
  });

  it('answers null for a document that was never OCR-ed', async () => {
    expect(await get(driver, 'missing')).toBeNull();
  });

  it('refreshes rather than duplicates on a second extraction', async () => {
    await save(driver, 'doc-a', 'first pass, blurry', 1_000);
    await save(driver, 'doc-a', 'second pass, sharper', 2_000);
    expect(await get(driver, 'doc-a')).toBe('second pass, sharper');
  });
});

suite('removing on release', () => {
  it('deletes the row, leaving nothing for a later search to find', async () => {
    await save(driver, 'doc-a', 'Amazon receipt', 1_000);
    await remove(driver, 'doc-a');
    expect(await get(driver, 'doc-a')).toBeNull();
    expect(await search(driver, 'Amazon')).toEqual([]);
  });

  it('is a no-op for a document that was never saved', async () => {
    await expect(remove(driver, 'never-existed')).resolves.toBeUndefined();
  });
});

suite('searching', () => {
  beforeEach(async () => {
    await save(driver, 'doc-a', 'Amazon receipt for one widget', 1_000);
    await save(driver, 'doc-b', 'Electric bill, due next month', 2_000);
    await save(driver, 'doc-c', 'Another Amazon order, two widgets', 3_000);
  });

  it('matches a plain substring, most-recently-extracted first', async () => {
    expect(await search(driver, 'Amazon')).toEqual(['doc-c', 'doc-a']);
  });

  it('returns nothing for text that matches no document', async () => {
    expect(await search(driver, 'nonexistent phrase')).toEqual([]);
  });

  it('returns everything matched most-recently-extracted first', async () => {
    expect(await search(driver, 'widget')).toEqual(['doc-c', 'doc-a']);
  });

  it('treats an empty query as no match at all, not everything', async () => {
    // Unlike @sheaf/archive-cache's search, which lists everything on an empty
    // query: the caller here already holds every `OutboxRow` in memory and asks
    // this table only to narrow, never to enumerate.
    expect(await search(driver, '')).toEqual([]);
    expect(await search(driver, '   ')).toEqual([]);
  });

  it('escapes SQL LIKE wildcards in the query text', async () => {
    await save(driver, 'doc-d', 'Contains a literal % percent sign', 4_000);
    expect(await search(driver, '%')).toEqual(['doc-d']);
  });
});
