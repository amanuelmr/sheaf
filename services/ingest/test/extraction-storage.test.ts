/**
 * Where extraction results live, and the rule that matters most about them: what a
 * person set is never overwritten by a machine (ADR 0010).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { ExtractedFields } from '@sheaf/extract';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Storage, sha256Hex } from '../src/storage';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nreceipt\n%%EOF\n'));
const hashA = sha256Hex(A);
const NOW = 1_700_000_000_000;

const MACHINE: ExtractedFields = {
  title: { value: 'Cinema City Invoice 2026-10-05', confidence: 0.6 },
  date: { value: '2026-10-05', confidence: 0.9 },
  correspondent: { value: 'Cinema City', confidence: 0.85 },
  total: { value: { minor: 3657, currency: 'MYR' }, confidence: 0.85 },
};

const save = (fields: ExtractedFields, version = 1) =>
  storage.saveExtraction(
    hashA,
    {
      version,
      provider: 'heuristic',
      model: 'heuristic-1',
      fields,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: 3,
    },
    NOW,
  );

let storage: Storage;

beforeEach(async () => {
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-extr-')),
  });
  await storage.put(hashA, A, NOW, 1);
});

suite('extraction results', () => {
  it('keeps each field with its source and confidence', async () => {
    await save(MACHINE);
    const fields = await storage.fields(hashA);
    expect(fields.find((f) => f.name === 'total')).toEqual({
      name: 'total',
      value: { minor: 3657, currency: 'MYR' },
      source: 'machine',
      confidence: 0.85,
      updatedAt: NOW,
    });
  });

  it('serves them as suggestions, which the phone already asks for', async () => {
    expect((await storage.record(hashA))!.suggestions).toBeNull();
    await save(MACHINE);
    expect((await storage.record(hashA))!.suggestions).toEqual({
      title: 'Cinema City Invoice 2026-10-05',
      date: '2026-10-05',
      correspondent: 'Cinema City',
    });
  });

  it('never lets a machine overwrite what a person set', async () => {
    await save(MACHINE);
    await storage.patch(hashA, { correspondent: 'Cinema City Ampang', title: null });
    await save({ ...MACHINE, correspondent: { value: 'CINEMA', confidence: 0.99 } }, 2);

    const fields = await storage.fields(hashA);
    expect(fields.find((f) => f.name === 'correspondent')).toMatchObject({
      value: 'Cinema City Ampang',
      source: 'user',
    });
    // Clearing a field is a choice too: the machine does not fill it back in.
    expect(fields.find((f) => f.name === 'title')).toMatchObject({ value: null, source: 'user' });
    expect(fields.find((f) => f.name === 'date')).toMatchObject({ source: 'machine' });
  });

  it('keeps every version, so extractors can be compared', async () => {
    await save(MACHINE, 1);
    await save({ date: MACHINE.date! }, 2);
    expect(await storage.extractionCount(hashA)).toBe(2);
  });

  it('can say there is nothing to suggest, but never replaces a real answer with that', async () => {
    await storage.recordNoSuggestions(hashA);
    expect((await storage.record(hashA))!.suggestions).toEqual({});

    await save(MACHINE);
    await storage.recordNoSuggestions(hashA);
    expect((await storage.record(hashA))!.suggestions).toMatchObject({ date: '2026-10-05' });
  });
});
