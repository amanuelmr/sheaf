/**
 * Suggestion-fetching is the same shape of problem as forwarding, once removed: a
 * document is already safe, so the only questions worth testing are about *when*
 * to ask again and when to stop. The property that matters most is the one that
 * does not look like a retry policy at all -- a successful, empty answer must be
 * treated as final, or the first poll to land before Paperless finishes
 * classifying a document would be the only one that ever runs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { Suggestions } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { SuggestionFetcher, type SuggestionSource } from '../src/suggestion-fetcher';
import { Storage, sha256Hex } from '../src/storage';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nsuggest me\n%%EOF\n'));
const hashA = sha256Hex(A);

interface Fake {
  source: SuggestionSource;
  calls: string[];
  getResult: ApiResult<Suggestions>;
}

function fakeSource(): Fake {
  const state: Fake = {
    calls: [],
    getResult: ok({ correspondent: 'Amazon' }),
    source: {
      get: (remoteId) => {
        state.calls.push(remoteId);
        return Promise.resolve(state.getResult);
      },
    },
  };
  return state;
}

let storage: Storage;
let fake: Fake;
let clock: number;
let fetcher: SuggestionFetcher;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-suggest-')),
  });
  await storage.put(hashA, A, clock, 1);
  fake = fakeSource();
  fetcher = new SuggestionFetcher(storage, fake.source, { now: () => clock, jitter: () => 0 });
});

async function markForwarded(remoteId = '4821'): Promise<void> {
  await storage.recordForwardAttempt(hashA, {
    state: 'done',
    attempts: 1,
    nextAt: null,
    remoteId,
    error: null,
    doneAt: clock,
  });
}

suite('what becomes due', () => {
  it('leaves a document alone until it has been forwarded and named', async () => {
    expect((await fetcher.tick()).examined).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('asks the moment a document has a remote id', async () => {
    await markForwarded();
    const result = await fetcher.tick();
    expect(result.examined).toBe(1);
    expect(fake.calls).toEqual(['4821']);
  });
});

suite('a successful answer is final', () => {
  it('caches a real suggestion and never asks again', async () => {
    await markForwarded();
    await fetcher.tick();
    expect((await storage.record(hashA))?.suggestions).toEqual({ correspondent: 'Amazon' });

    fake.calls = [];
    expect((await fetcher.tick()).examined).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('caches an empty answer just as finally -- there is no way to tell "not yet" from "never"', async () => {
    fake.getResult = ok({});
    await markForwarded();
    await fetcher.tick();

    const record = await storage.record(hashA);
    expect(record?.suggestions).toEqual({});

    fake.calls = [];
    expect((await fetcher.tick()).examined).toBe(0);
  });
});

suite('a failed answer is not', () => {
  it('backs off a transient failure rather than abandoning it', async () => {
    fake.getResult = err({ kind: 'unreachable' });
    await markForwarded();
    const result = await fetcher.tick();
    expect(result.fetched).toBe(0);
    expect(result.abandoned).toBe(0);
    expect((await storage.record(hashA))?.suggestions).toBeNull();

    // Not due yet.
    fake.calls = [];
    expect((await fetcher.tick()).examined).toBe(0);

    clock += 60_000;
    expect((await fetcher.tick()).examined).toBe(1);
  });

  it('keeps trying an unreachable classifier for as long as it takes', async () => {
    fake.getResult = err({ kind: 'server_error', status: 503 });
    await markForwarded();
    for (let i = 0; i < 30; i++) {
      clock += 10 * 60_000;
      await fetcher.tick();
    }
    expect((await storage.record(hashA))?.suggestions).toBeNull();

    fake.getResult = ok({ documentType: 'Receipt' });
    clock += 10 * 60_000;
    const result = await fetcher.tick();
    expect(result.fetched).toBe(1);
    expect((await storage.record(hashA))?.suggestions).toEqual({ documentType: 'Receipt' });
  });

  it('does not retry a refusal that retrying cannot change', async () => {
    fake.getResult = err({ kind: 'not_found' });
    await markForwarded();
    const result = await fetcher.tick();
    expect(result.abandoned).toBe(1);

    clock += 60 * 60_000;
    fake.calls = [];
    expect((await fetcher.tick()).examined).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});
