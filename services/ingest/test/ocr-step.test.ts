/**
 * The server reads a document itself only when nobody else has (ADR 0009): the
 * phone's text gets a head start, and a document that has any text is left alone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { JobRunner } from '../src/jobs';
import { ocrStep, type OcrFetch } from '../src/steps/ocr';
import { Storage, sha256Hex } from '../src/storage';
import { toMatch } from '../src/search-query';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nscanned image only\n%%EOF\n'));
const hashA = sha256Hex(A);
const GRACE = 120_000;

let driver: NodeSqliteDriver;
let storage: Storage;
let clock: number;
let calls: Uint8Array[];
let answer: () => Promise<{ status: number; body: string }>;

const fetchOcr: OcrFetch = async (_url, body) => {
  calls.push(body);
  const { status, body: text } = await answer();
  return { status, text: () => Promise.resolve(text) };
};

const runner = () =>
  new JobRunner(
    driver,
    storage,
    [ocrStep(storage, { url: 'http://ocr:8080', fetch: fetchOcr, graceMs: GRACE })],
    { now: () => clock, jitter: () => 0.5 },
  );

const jobState = async (): Promise<string | undefined> =>
  (
    await driver.all<{ state: string }>(
      "SELECT state FROM jobs WHERE step = 'ocr' AND sha256 = ?",
      [hashA],
    )
  )[0]?.state;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  calls = [];
  answer = () =>
    Promise.resolve({
      status: 200,
      body: JSON.stringify({ text: 'INVOICE 2026-10-01 total 99.00', engine: 'ocrmypdf-17.13.0' }),
    });
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-ocr-')) });
  await storage.put(hashA, A, clock, 1);
});

suite('the OCR step', () => {
  it('waits for the phone’s text before reading a document itself', async () => {
    await runner().tick();
    expect(calls).toEqual([]);
    clock += GRACE;
    await runner().tick();
    expect(calls).toHaveLength(1);
  });

  it('sends the stored bytes and makes the result searchable', async () => {
    clock += GRACE;
    await runner().tick();
    expect(calls[0]).toEqual(A);
    const texts = await storage.texts(hashA);
    expect(texts).toEqual([
      expect.objectContaining({ source: 'ocrmypdf', engine: 'ocrmypdf-17.13.0' }),
    ]);
    expect((await storage.search(toMatch('invoice')!, 5, 0)).hits).toHaveLength(1);
  });

  it('leaves alone a document that already has text', async () => {
    await storage.putText(
      hashA,
      { source: 'edge', engine: 'mlkit', text: 'from the phone' },
      clock,
    );
    clock += GRACE;
    await runner().tick();
    expect(calls).toEqual([]);
    expect(await jobState()).toBe('skipped');
  });

  it('records that a document had no readable text, so it is not read again', async () => {
    answer = () =>
      Promise.resolve({ status: 200, body: '{"text":"  ","engine":"ocrmypdf-17.13.0"}' });
    clock += GRACE;
    await runner().tick();
    await runner().tick();
    expect(calls).toHaveLength(1);
    expect(await jobState()).toBe('done');
    expect(await storage.texts(hashA)).toEqual([]);
  });

  it('retries when the OCR service is down, and gives up on a PDF it cannot read', async () => {
    answer = () => Promise.reject(new Error('connect ECONNREFUSED'));
    clock += GRACE;
    await runner().tick();
    expect(await jobState()).toBe('pending');

    answer = () => Promise.resolve({ status: 422, body: '{"error":"not a readable PDF"}' });
    clock += 60 * 60 * 1000;
    await runner().tick();
    expect(await jobState()).toBe('given_up');
  });

  it('treats an answer that is not the expected JSON as a refusal, not a crash', async () => {
    answer = () => Promise.resolve({ status: 200, body: '<html>proxy error</html>' });
    clock += GRACE;
    await runner().tick();
    expect(await jobState()).toBe('given_up');
  });
});
