/**
 * The search index has to agree with what is stored, whichever way a document
 * changed: stored, given text, or edited. And a database from before the index
 * existed has to end up searchable without anyone doing anything.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const A = pdf('a');
const B = pdf('b');
const hashA = sha256Hex(A);
const hashB = sha256Hex(B);
const NOW = 1_700_000_000_000;

let storage: Storage;

beforeEach(async () => {
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-fts-')),
  });
});

const find = async (q: string): Promise<string[]> =>
  (await storage.search(toMatch(q)!, 20, 0)).hits.map((hit) => hit.sha256);

const text = (t: string) => ({ source: 'edge' as const, engine: 'mlkit', text: t });

suite('the search index', () => {
  it('finds a document by the text recognised in it', async () => {
    await storage.put(hashA, A, NOW, 1);
    await storage.put(hashB, B, NOW, 1);
    await storage.putText(hashA, text('CINEMA CITY total 12.50'), NOW);
    expect(await find('cinema')).toEqual([hashA]);
    expect(await find('total cinema')).toEqual([hashA]);
    expect(await find('restaurant')).toEqual([]);
  });

  it('finds a document by the details someone gave it, and forgets the old ones', async () => {
    await storage.put(hashA, A, NOW, 1);
    await storage.patch(hashA, { title: 'Electricity bill', tags: ['utilities'] });
    expect(await find('electricity')).toEqual([hashA]);
    expect(await find('utilities')).toEqual([hashA]);

    await storage.patch(hashA, { title: 'Water bill' });
    expect(await find('electricity')).toEqual([]);
    expect(await find('water')).toEqual([hashA]);
  });

  it('matches without accents, and a word still being typed', async () => {
    await storage.put(hashA, A, NOW, 1);
    await storage.putText(hashA, text('Café Müller Rechnung'), NOW);
    expect(await find('cafe muller')).toEqual([hashA]);
    expect(await find('rech')).toEqual([hashA]);
  });

  it('ranks a match in the title above a match in the body', async () => {
    await storage.put(hashA, A, NOW, 1);
    await storage.put(hashB, B, NOW, 1);
    await storage.putText(
      hashA,
      text('a long receipt mentioning insurance once among many words'),
      NOW,
    );
    await storage.patch(hashB, { title: 'Insurance' });
    expect(await find('insurance')).toEqual([hashB, hashA]);
  });

  it('returns a snippet with the match marked', async () => {
    await storage.put(hashA, A, NOW, 1);
    await storage.putText(hashA, text('Thank you for visiting CINEMA CITY tonight'), NOW);
    const [hit] = (await storage.search(toMatch('cinema')!, 20, 0)).hits;
    expect(hit!.snippet).toContain('«CINEMA»');
  });

  it('pages through results and says when there are more', async () => {
    for (let i = 0; i < 5; i++) {
      const bytes = pdf(`doc ${String(i)}`);
      await storage.put(sha256Hex(bytes), bytes, NOW + i, 1);
      await storage.putText(sha256Hex(bytes), text(`invoice number ${String(i)}`), NOW);
    }
    const first = await storage.search(toMatch('invoice')!, 2, 0);
    const last = await storage.search(toMatch('invoice')!, 2, 4);
    expect(first.hits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(last.hits).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('indexes, on open, documents stored before the index existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheaf-fts-old-'));
    const file = join(dir, 'ingest.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'v0.2-ingest.db'), file);
    const old = await Storage.open({ driver: nodeSqliteDriver(file), objectsDir: join(dir, 'o') });

    // The fixture's documents have no titles or text, so search by a patched title.
    const [first] = await old.list(1);
    await old.patch(first!.sha256, { title: 'Recovered' });
    expect((await old.search(toMatch('recovered')!, 20, 0)).hits).toHaveLength(1);
    expect(await old.indexedCount()).toBe(await old.count());
  });
});
