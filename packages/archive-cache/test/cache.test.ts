/**
 * The property that matters here is asymmetric on purpose: a document that was
 * merely viewed can vanish the moment the cache is full, and that has to be fine
 * -- it is still one request away from the archive. A document someone starred
 * must never vanish on its own, because the whole reason to star something is to
 * promise it will still be there without a connection.
 */
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { ArchiveDocument } from '@sheaf/protocol';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { evictUnstarred, get, migrateArchiveCache, save, search, setStarred } from '../src/index';

const doc = (overrides: Partial<ArchiveDocument> = {}): ArchiveDocument => ({
  id: 4821,
  title: 'Amazon receipt',
  correspondent: 'Amazon',
  documentType: 'Receipt',
  tags: ['shopping'],
  created: '2026-08-22',
  contentSnippet: 'Thank you for your order of one widget.',
  ...overrides,
});

let driver: NodeSqliteDriver;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  await migrateArchiveCache(driver);
});

suite('saving what was opened', () => {
  it('round-trips every field', async () => {
    await save(driver, doc(), '/tmp/4821.webp', 1_000);
    expect(await get(driver, 4821)).toEqual({
      id: 4821,
      title: 'Amazon receipt',
      correspondent: 'Amazon',
      documentType: 'Receipt',
      tags: ['shopping'],
      created: '2026-08-22',
      contentSnippet: 'Thank you for your order of one widget.',
      thumbnailPath: '/tmp/4821.webp',
      starred: false,
      cachedAt: 1_000,
    });
  });

  it('is null for a document never opened', async () => {
    expect(await get(driver, 1)).toBeNull();
  });

  it('refreshes on a second view rather than duplicating the row', async () => {
    await save(driver, doc({ title: 'Amazon receipt' }), null, 1_000);
    await save(driver, doc({ title: 'Amazon receipt (renamed)' }), '/tmp/4821.webp', 2_000);
    const cached = await get(driver, 4821);
    expect(cached?.title).toBe('Amazon receipt (renamed)');
    expect(cached?.thumbnailPath).toBe('/tmp/4821.webp');
    expect(cached?.cachedAt).toBe(2_000);
    expect((await search(driver, '')).length).toBe(1);
  });

  it('never stars or unstars a document just because it was viewed again', async () => {
    await save(driver, doc(), null, 1_000);
    await setStarred(driver, 4821, true);
    await save(driver, doc(), null, 2_000);
    expect((await get(driver, 4821))?.starred).toBe(true);
  });

  it('tolerates a missing thumbnail -- caching the metadata never depends on it', async () => {
    await save(driver, doc(), null, 1_000);
    expect((await get(driver, 4821))?.thumbnailPath).toBeNull();
  });
});

suite('search', () => {
  beforeEach(async () => {
    await save(driver, doc(), null, 1_000);
    await save(
      driver,
      doc({
        id: 1,
        title: 'Water bill',
        correspondent: 'Vattenfall',
        documentType: 'Bill',
        tags: ['utilities'],
        contentSnippet: null,
      }),
      null,
      2_000,
    );
  });

  it('lists everything cached, most recently viewed first, when there is no query', async () => {
    const results = await search(driver, '');
    expect(results.map((d) => d.id)).toEqual([1, 4821]);
  });

  it('matches a title', async () => {
    expect((await search(driver, 'water')).map((d) => d.id)).toEqual([1]);
  });

  it('matches a correspondent, case-insensitively', async () => {
    expect((await search(driver, 'AMAZON')).map((d) => d.id)).toEqual([4821]);
  });

  it('matches a tag', async () => {
    expect((await search(driver, 'utilities')).map((d) => d.id)).toEqual([1]);
  });

  it('matches inside the content snippet', async () => {
    expect((await search(driver, 'widget')).map((d) => d.id)).toEqual([4821]);
  });

  it('finds nothing for a term that matches nothing', async () => {
    expect(await search(driver, 'nonexistent')).toEqual([]);
  });

  it('treats a literal percent sign as text, not a wildcard', async () => {
    await save(driver, doc({ id: 2, title: '50% off', contentSnippet: null }), null, 3_000);
    expect((await search(driver, '50%')).map((d) => d.id)).toEqual([2]);
    expect((await search(driver, '50x')).length).toBe(0);
  });

  it('puts a starred match ahead of a more recent unstarred one', async () => {
    await setStarred(driver, 4821, true); // older, but starred
    const results = await search(driver, '');
    expect(results[0]?.id).toBe(4821);
  });
});

suite('eviction', () => {
  it('leaves a cache under the cap alone', async () => {
    await save(driver, doc({ id: 1 }), null, 1_000);
    await save(driver, doc({ id: 2 }), null, 2_000);
    expect(await evictUnstarred(driver, 5)).toEqual([]);
    expect((await search(driver, '')).length).toBe(2);
  });

  it('removes the oldest unstarred rows once over the cap, and reports their thumbnails', async () => {
    await save(driver, doc({ id: 1 }), '/tmp/1.webp', 1_000);
    await save(driver, doc({ id: 2 }), '/tmp/2.webp', 2_000);
    await save(driver, doc({ id: 3 }), null, 3_000);

    const removed = await evictUnstarred(driver, 2);
    expect(removed).toEqual(['/tmp/1.webp']);
    expect((await search(driver, '')).map((d) => d.id).sort()).toEqual([2, 3]);
  });

  it('never removes a starred document, even when it is the oldest', async () => {
    await save(driver, doc({ id: 1 }), null, 1_000);
    await setStarred(driver, 1, true);
    await save(driver, doc({ id: 2 }), null, 2_000);
    await save(driver, doc({ id: 3 }), null, 3_000);

    await evictUnstarred(driver, 1);
    expect((await search(driver, '')).map((d) => d.id)).toContain(1);
  });
});
