/**
 * Labels filing documents by their own rules: only what nobody chose, inbox tags on
 * new documents only, and again on request for the documents already here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { MatchingAlgorithm } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Labels } from '../src/labels';
import { Rules } from '../src/rules';
import { toMatch } from '../src/search-query';
import { matchStep } from '../src/steps/match';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B] = [pdf('a'), pdf('b')];
const [hashA, hashB] = [A, B].map(sha256Hex) as [string, string];
const NOW = 1_700_000_000_000;

let driver: SqlDriver;
let storage: Storage;
let labels: Labels;
let rules: Rules;

const rule = (algorithm: MatchingAlgorithm, pattern: string) => ({
  algorithm,
  pattern,
  caseSensitive: false,
});

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-rl-')) });
  labels = new Labels(driver, storage);
  rules = new Rules(driver, storage);
  await storage.put(hashA, A, NOW, 1);
  await storage.put(hashB, B, NOW, 1);
  await storage.putText(
    hashA,
    { source: 'edge', engine: 'mlkit', text: 'City Power invoice for March' },
    NOW,
  );
  await labels.create('correspondent', {
    name: 'City Power',
    matching: rule('exact', 'city power'),
  });
  await labels.create('correspondent', { name: 'Water Co', matching: rule('any', 'water') });
  await labels.create('documentType', { name: 'Invoice', matching: rule('any', 'invoice') });
  await labels.create('tag', { name: 'bills', matching: rule('any', 'invoice receipt') });
  await labels.create('tag', { name: 'unread', inbox: true });
  await labels.create('tag', { name: 'tax', matching: rule('all', 'tax return') });
});

suite('applying rules to a new document', () => {
  it('files it under every label whose rule matches, with the inbox tag', async () => {
    const applied = await rules.apply(hashA, { inbox: true });
    expect(applied).toEqual({
      correspondent: 'City Power',
      documentType: 'Invoice',
      tags: ['bills', 'unread'],
    });
    const record = await storage.record(hashA);
    expect(record).toMatchObject({
      correspondent: 'City Power',
      documentType: 'Invoice',
      tags: ['bills', 'unread'],
    });
    expect((await storage.search(toMatch('bills')!, 5, 0)).hits.map((h) => h.sha256)).toEqual([
      hashA,
    ]);
  });

  it('leaves alone what a person chose, cleared included', async () => {
    await storage.patch(hashA, { correspondent: null, tags: ['mine'] }, NOW);
    const applied = await rules.apply(hashA, { inbox: true });
    expect(applied).toEqual({ documentType: 'Invoice', tags: [] });
    expect(await storage.record(hashA)).toMatchObject({ correspondent: null, tags: ['mine'] });
  });

  it('never replaces a correspondent already there', async () => {
    await driver.run(`UPDATE documents SET correspondent = 'Water Co' WHERE sha256 = ?`, [hashA]);
    await rules.apply(hashA, { inbox: false });
    expect((await storage.record(hashA))?.correspondent).toBe('Water Co');
  });

  it('gives a document with no text only the inbox tag', async () => {
    expect(await rules.apply(hashB, { inbox: true })).toEqual({ tags: ['unread'] });
  });

  it('runs as a job step', async () => {
    const step = matchStep(storage, rules, { graceMs: 1000 });
    const record = (await storage.record(hashB))!;
    expect(await step.notBefore!(record)).toBe(NOW + 1000);
    expect(await step.run(record, { now: NOW })).toEqual({ ok: true, value: null });
    expect((await storage.record(hashB))?.tags).toEqual(['unread']);
  });
});

suite('applying rules again to documents already here', () => {
  it('files them without the inbox tag, and counts those that changed', async () => {
    expect(await rules.applyAll()).toBe(1);
    expect((await storage.record(hashA))?.tags).toEqual(['bills']);
    expect((await storage.record(hashB))?.tags).toEqual([]);
    expect(await rules.applyAll()).toBe(0);
  });

  it('skips the trash', async () => {
    await storage.trash(hashA, NOW);
    expect(await rules.applyAll()).toBe(0);
    expect(await rules.apply(hashA, { inbox: false })).toBeNull();
  });
});
