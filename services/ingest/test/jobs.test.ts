/**
 * The job runner's promises are about what it will *not* do: run a finished step
 * again, run a step before the one it depends on, retry a refusal, or lose a job
 * to a crash. Each test pins one of those down.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { FailureReason } from '@sheaf/core';
import { err, ok, type ApiResult } from '@sheaf/http';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { JobRunner, type Step } from '../src/jobs';
import { Storage, sha256Hex } from '../src/storage';

const doc = (text: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`));
const A = doc('a');
const hashA = sha256Hex(A);

let driver: NodeSqliteDriver;
let storage: Storage;
let clock: number;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-jobs-')) });
  await storage.put(hashA, A, clock, 1);
});

interface FakeStep extends Step {
  runs: string[];
  result: ApiResult<null>;
}

function fakeStep(
  name: string,
  overrides: Partial<Step> & { result?: ApiResult<null> } = {},
): FakeStep {
  const step: FakeStep = {
    name,
    version: 1,
    after: [],
    budget: null,
    runs: [],
    result: ok(null),
    applies: () => Promise.resolve(true),
    run: (document) => {
      step.runs.push(document.sha256);
      return Promise.resolve(step.result);
    },
    ...overrides,
  };
  return step;
}

const runner = (steps: readonly Step[]): JobRunner =>
  new JobRunner(driver, storage, steps, { now: () => clock, jitter: () => 0.5 });

async function stateOf(step: string, version = 1): Promise<string | undefined> {
  const rows = await driver.all<{ state: string }>(
    'SELECT state FROM jobs WHERE sha256 = ? AND step = ? AND version = ?',
    [hashA, step, version],
  );
  return rows[0]?.state;
}

suite('JobRunner', () => {
  it('runs a step once, and never again once it is done', async () => {
    const step = fakeStep('ocr');
    const jobs = runner([step]);
    await jobs.tick();
    await jobs.tick();
    await jobs.tick();
    expect(step.runs).toEqual([hashA]);
    expect(await stateOf('ocr')).toBe('done');
  });

  it('runs a new version of a step again, and keeps the old result', async () => {
    await runner([fakeStep('extract', { version: 1 })]).tick();
    const v2 = fakeStep('extract', { version: 2 });
    await runner([v2]).tick();
    expect(v2.runs).toEqual([hashA]);
    expect(await stateOf('extract', 1)).toBe('done');
    expect(await stateOf('extract', 2)).toBe('done');
  });

  it('waits for the steps it comes after', async () => {
    const ocr = fakeStep('ocr', { result: err({ kind: 'unreachable' }) });
    const extract = fakeStep('extract', { after: ['ocr'] });
    const jobs = runner([ocr, extract]);

    await jobs.tick();
    expect(extract.runs).toEqual([]);

    ocr.result = ok(null);
    clock += 60 * 60 * 1000;
    await jobs.tick();
    await jobs.tick();
    expect(extract.runs).toEqual([hashA]);
  });

  it('treats a step that is not registered as finished, so an optional step never blocks', async () => {
    const extract = fakeStep('extract', { after: ['ocr'] });
    await runner([extract]).tick();
    expect(extract.runs).toEqual([hashA]);
  });

  it('skips a step that does not apply, and lets the next one run', async () => {
    const ocr = fakeStep('ocr', { applies: () => Promise.resolve(false) });
    const extract = fakeStep('extract', { after: ['ocr'] });
    const jobs = runner([ocr, extract]);
    await jobs.tick();
    await jobs.tick();
    expect(ocr.runs).toEqual([]);
    expect(await stateOf('ocr')).toBe('skipped');
    expect(extract.runs).toEqual([hashA]);
  });

  it('does not start a step before its notBefore time', async () => {
    const ocr = fakeStep('ocr', { notBefore: (d) => d.receivedAt + 120_000 });
    const jobs = runner([ocr]);
    await jobs.tick();
    expect(ocr.runs).toEqual([]);
    clock += 120_000;
    await jobs.tick();
    expect(ocr.runs).toEqual([hashA]);
  });

  it('backs off after a retryable failure instead of retrying on the next tick', async () => {
    const step = fakeStep('ocr', { result: err({ kind: 'server_error', status: 503 }) });
    const jobs = runner([step]);
    await jobs.tick();
    await jobs.tick();
    expect(step.runs).toHaveLength(1);
    expect(await stateOf('ocr')).toBe('pending');

    clock += 60 * 60 * 1000;
    await jobs.tick();
    expect(step.runs).toHaveLength(2);
  });

  it('gives up at once on a failure that retrying cannot change', async () => {
    const refusal: FailureReason = { kind: 'rejected', status: 400, message: 'no' };
    const step = fakeStep('extract', { result: err(refusal) });
    const jobs = runner([step]);
    await jobs.tick();
    clock += 60 * 60 * 1000;
    await jobs.tick();
    expect(step.runs).toHaveLength(1);
    expect(await stateOf('extract')).toBe('given_up');
  });

  it('lets a step leave a final answer when it is given up on, once', async () => {
    const givenUp: string[] = [];
    const step = fakeStep('extract', {
      budget: 2,
      result: err({ kind: 'unreachable' }),
      onGiveUp: (document) => {
        givenUp.push(document.sha256);
        return Promise.resolve();
      },
    });
    const jobs = runner([step]);
    for (let i = 0; i < 6; i++) {
      await jobs.tick();
      clock += 60 * 60 * 1000;
    }
    expect(givenUp).toEqual([hashA]);
  });

  it('gives up on retryable failures only when the step has a budget and it is spent', async () => {
    const step = fakeStep('extract', { budget: 3, result: err({ kind: 'unreachable' }) });
    const jobs = runner([step]);
    for (let i = 0; i < 10; i++) {
      await jobs.tick();
      clock += 60 * 60 * 1000;
    }
    expect(step.runs).toHaveLength(3);
    expect(await stateOf('extract')).toBe('given_up');
  });

  it('finishes a job whose run crashed, on a later tick', async () => {
    let crash = true;
    const step = fakeStep('ocr', {
      run: () => {
        if (crash) return Promise.reject(new Error('process died'));
        return Promise.resolve(ok(null));
      },
    });
    const jobs = runner([step]);

    await expect(jobs.tick()).rejects.toThrow('process died');
    expect(await stateOf('ocr')).toBe('running');

    crash = false;
    await runner([step]).tick();
    expect(await stateOf('ocr')).toBe('done');
  });

  it('enqueues documents stored after the runner started', async () => {
    const step = fakeStep('ocr');
    const jobs = runner([step]);
    await jobs.tick();

    const B = doc('b');
    await storage.put(sha256Hex(B), B, clock, 1);
    await jobs.tick();
    expect(step.runs).toEqual([hashA, sha256Hex(B)]);
  });

  it('refuses two steps with the same name', () => {
    expect(() => runner([fakeStep('ocr'), fakeStep('ocr')])).toThrow(/twice/);
  });
});
