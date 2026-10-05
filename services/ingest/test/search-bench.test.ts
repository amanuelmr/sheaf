/**
 * Search has to stay fast on a real archive, not just on a handful of test
 * documents. Ten thousand documents of about three hundred words each is a decade
 * of household paper; the target is that any search answers well inside a frame.
 *
 * The bound asserted here (p95 under 50 ms) is loose on purpose, so a slow CI
 * runner does not fail it. The numbers printed are what goes in the README.
 *
 * Building the index takes about ten seconds, so this runs only with SHEAF_BENCH=1
 * (`pnpm bench:search`), as its own CI step, rather than in every `pnpm test`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { rng } from '@sheaf/sim';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { toMatch } from '../src/search-query';
import { Storage } from '../src/storage';

const DOCUMENTS = 10_000;
const WORDS_PER_DOCUMENT = 300;
const QUERIES = 50;

/** A vocabulary with a long tail, like real text: a few words everywhere, most rare. */
const VOCABULARY = Array.from({ length: 5_000 }, (_, i) => `w${i.toString(36)}`);
const COMMON = ['total', 'invoice', 'receipt', 'date', 'amount', 'thank', 'you', 'vat'];

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

suite('search at scale', () => {
  it.runIf(process.env['SHEAF_BENCH'] === '1')(
    `answers over ${String(DOCUMENTS)} documents in well under a frame`,
    async () => {
      const random = rng(7);
      const driver = nodeSqliteDriver();
      const storage = await Storage.open({
        driver,
        objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-bench-')),
      });

      const word = (): string =>
        random.chance(0.2)
          ? random.pick(COMMON)
          : VOCABULARY[Math.floor(VOCABULARY.length * random.next() ** 3)]!;

      await driver.transaction(async () => {
        for (let i = 0; i < DOCUMENTS; i++) {
          const sha256 = i.toString(16).padStart(64, '0');
          const text = Array.from({ length: WORDS_PER_DOCUMENT }, word).join(' ');
          await driver.run(
            `INSERT INTO documents (sha256, bytes, received_at, title, tags) VALUES (?, 1, ?, ?, '[]')`,
            [sha256, i, `Document ${String(i)}`],
          );
          await driver.run(
            `INSERT INTO document_text (sha256, source, engine, text, received_at)
           VALUES (?, 'edge', 'bench', ?, ?)`,
            [sha256, text, i],
          );
        }
      });

      const indexStart = performance.now();
      expect(await storage.reindexMissing()).toBe(DOCUMENTS);
      const indexMs = performance.now() - indexStart;

      const timings: number[] = [];
      for (let q = 0; q < QUERIES; q++) {
        const query = q % 2 === 0 ? `${random.pick(COMMON)} ${word()}` : word().slice(0, 3);
        const start = performance.now();
        await storage.search(toMatch(query)!, 20, 0);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);

      const p50 = percentile(timings, 50);
      const p95 = percentile(timings, 95);
      console.log(
        `search over ${String(DOCUMENTS)} docs × ${String(WORDS_PER_DOCUMENT)} words: ` +
          `index ${(indexMs / 1000).toFixed(1)} s, p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
      );
      expect(p95).toBeLessThan(50);
    },
    120_000,
  );
});
