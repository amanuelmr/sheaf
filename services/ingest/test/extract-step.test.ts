/**
 * The extract step: reads each document once it has text, turns the result into the
 * suggestions the phone asks for, and always leaves an answer behind, even "none".
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { err, ok } from '@sheaf/http';
import { heuristicExtractor, type Extractor } from '@sheaf/extract';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { JobRunner } from '../src/jobs';
import { extractStep } from '../src/steps/extract';
import { Storage, sha256Hex } from '../src/storage';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nreceipt\n%%EOF\n'));
const hashA = sha256Hex(A);
const GRACE = 120_000;
const RECEIPT = 'CINEMA CITY\nDate: 05/10/2026\nTOTAL 36.57';

let driver: NodeSqliteDriver;
let storage: Storage;
let clock: number;

const runner = (extractor: Extractor = heuristicExtractor()) =>
  new JobRunner(
    driver,
    storage,
    [extractStep(storage, { extractor, dateOrder: 'DMY', defaultCurrency: 'MYR', graceMs: GRACE })],
    { now: () => clock, jitter: () => 0.5 },
  );

const suggestions = async () => (await storage.record(hashA))!.suggestions;

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 5, 20);
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-xs-')) });
  await storage.put(hashA, A, clock, 1);
});

suite('the extract step', () => {
  it('runs as soon as there is text, and turns the result into suggestions', async () => {
    await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: RECEIPT }, clock);
    await runner().tick();
    expect(await suggestions()).toMatchObject({ correspondent: 'CINEMA CITY', date: '2026-10-05' });
    expect((await storage.fields(hashA)).find((f) => f.name === 'total')?.value).toEqual({
      minor: 3657,
      currency: 'MYR',
    });
  });

  it('waits for text, then answers "nothing to suggest" if none ever comes', async () => {
    await runner().tick();
    expect(await suggestions()).toBeNull();
    clock += GRACE;
    await runner().tick();
    expect(await suggestions()).toEqual({});
  });

  it('runs again when text arrives later, replacing the empty answer', async () => {
    clock += GRACE;
    await runner().tick();
    expect(await suggestions()).toEqual({});

    await storage.putText(
      hashA,
      { source: 'ocrmypdf', engine: 'ocrmypdf-17', text: RECEIPT },
      clock,
    );
    await runner().tick();
    expect(await suggestions()).toMatchObject({ date: '2026-10-05' });
  });

  it('leaves "nothing to suggest" behind when the extractor fails for good', async () => {
    await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: RECEIPT }, clock);
    const refusing: Extractor = {
      name: 'claude',
      version: 1,
      extract: () => Promise.resolve(err({ kind: 'rejected', status: 400, message: 'no' })),
    };
    await runner(refusing).tick();
    expect(await suggestions()).toEqual({});
  });

  it('records which extractor ran, how long it took, and what it cost', async () => {
    await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: RECEIPT }, clock);
    const priced: Extractor = {
      name: 'claude',
      version: 3,
      extract: () =>
        Promise.resolve(
          ok({
            fields: { date: { value: '2026-10-05', confidence: 0.9 } },
            usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0015 },
            model: 'claude-haiku-4-5-20251001',
          }),
        ),
    };
    await runner(priced).tick();
    const rows = await driver.all<{ provider: string; model: string; cost_usd: number }>(
      'SELECT provider, model, cost_usd FROM extractions WHERE sha256 = ?',
      [hashA],
    );
    expect(rows).toEqual([
      { provider: 'claude', model: 'claude-haiku-4-5-20251001', cost_usd: 0.0015 },
    ]);
  });

  it('re-extracts everything when the provider changes, keeping both runs', async () => {
    await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: RECEIPT }, clock);
    await runner().tick();
    const other: Extractor = { ...heuristicExtractor(), name: 'ollama' };
    await runner(other).tick();
    expect(await storage.extractionCount(hashA)).toBe(2);
  });
});
