import { backoffMs, isRetryable } from '@sheaf/core';
import type { FailureReason } from '@sheaf/core';
import type { ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { Storage } from './storage.ts';

/**
 * Work done to a document after it is stored: reading its text, extracting its
 * details, and whatever comes next.
 *
 * Every step must be **idempotent**: its results are written keyed by document and
 * step version, so running it twice leaves the same thing behind as running it
 * once. The runner relies on that to recover from a crash by simply running the
 * step again, which is far simpler than knowing how far it got.
 *
 * Steps follow ADR 0005: return a result for a failure you expect, throw only for
 * what nobody can handle.
 */
export interface Step {
  readonly name: string;
  /** Bump to run the step again over every document, e.g. after a prompt change. */
  readonly version: number;
  /** Steps that must finish first. A step that is not registered counts as finished. */
  readonly after: readonly string[];
  /**
   * How many attempts a retryable failure gets before the job is given up, or
   * `null` to keep retrying for ever. A refusal that retrying cannot change is
   * given up at once either way.
   */
  readonly budget: number | null;
  /** The earliest time this step may run for a document. */
  notBefore?(document: DocumentRecord): number | Promise<number>;
  /** Whether this document needs the step at all, decided when it is about to run. */
  applies(document: DocumentRecord): Promise<boolean>;
  run(document: DocumentRecord, context: StepContext): Promise<ApiResult<null>>;
  /**
   * Called once when the runner stops trying, so the step can leave a final answer
   * behind (an extraction that will never come can say so). Must be idempotent.
   */
  onGiveUp?(document: DocumentRecord, context: StepContext): Promise<void>;
}

export interface StepContext {
  readonly now: number;
}

export interface JobRunnerPorts {
  now(): number;
  /** In [0, 1). Keeps a backlog from retrying in lockstep. */
  jitter(): number;
}

export interface JobRunnerResult {
  readonly enqueued: number;
  readonly ran: number;
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}

type JobState = 'pending' | 'running' | 'done' | 'skipped' | 'given_up';

interface JobRow {
  readonly sha256: string;
  readonly step: string;
  readonly version: number;
  readonly attempts: number;
}

/** States that let the steps after this one go ahead. */
const FINISHED: readonly JobState[] = ['done', 'skipped', 'given_up'];

/** How often a waiting job is looked at again before its start time. */
const RECHECK_MS = 5_000;
const ENQUEUE_BATCH = 100;
const RUN_BATCH = 20;

/**
 * Moves every document through every registered step, a few at a time.
 *
 * Assumes it is the only runner on this database, and that ticks never overlap:
 * `main.ts` skips a tick while the previous one is running. Under that assumption a
 * job found `running` at the start of a tick can only belong to a run that crashed,
 * so it is put back to `pending` and, steps being idempotent, simply run again.
 */
export class JobRunner {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;
  readonly #steps: readonly Step[];
  readonly #ports: JobRunnerPorts;

  constructor(driver: SqlDriver, storage: Storage, steps: readonly Step[], ports: JobRunnerPorts) {
    const names = new Set<string>();
    for (const step of steps) {
      if (names.has(step.name)) throw new Error(`step "${step.name}" is registered twice`);
      names.add(step.name);
    }
    this.#driver = driver;
    this.#storage = storage;
    this.#steps = steps;
    this.#ports = ports;
  }

  async tick(): Promise<JobRunnerResult> {
    const result = { enqueued: 0, ran: 0, done: 0, skipped: 0, failed: 0 };
    if (this.#steps.length === 0) return result;

    await this.#driver.run(`UPDATE jobs SET state = 'pending' WHERE state = 'running'`);
    result.enqueued = await this.#enqueue();

    for (const job of await this.#due()) {
      const step = this.#steps.find((s) => s.name === job.step)!;
      if (!(await this.#prerequisitesFinished(job.sha256, step))) continue;

      const outcome = await this.#run(job, step);
      if (outcome === 'waiting') continue;
      result.ran += outcome === 'skipped' ? 0 : 1;
      if (outcome === 'done') result.done += 1;
      if (outcome === 'skipped') result.skipped += 1;
      if (outcome === 'given_up') result.failed += 1;
    }
    return result;
  }

  /** A pending row for every document that has none yet for a step's current version. */
  async #enqueue(): Promise<number> {
    const now = this.#ports.now();
    let added = 0;
    for (const step of this.#steps) {
      const before = await this.#count();
      await this.#driver.run(
        `INSERT OR IGNORE INTO jobs (sha256, step, version, state, attempts, created_at)
         SELECT d.sha256, ?, ?, 'pending', 0, ?
           FROM documents d
          WHERE NOT EXISTS (
                  SELECT 1 FROM jobs j
                   WHERE j.sha256 = d.sha256 AND j.step = ? AND j.version = ?)
          ORDER BY d.received_at ASC
          LIMIT ?`,
        [step.name, step.version, now, step.name, step.version, ENQUEUE_BATCH],
      );
      added += (await this.#count()) - before;
    }
    return added;
  }

  async #count(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM jobs');
    return rows[0]?.n ?? 0;
  }

  /** Pending jobs for the registered version of each step, oldest first. */
  async #due(): Promise<readonly JobRow[]> {
    const current = this.#steps.map(() => '(step = ? AND version = ?)').join(' OR ');
    const params = this.#steps.flatMap((step) => [step.name, step.version]);
    return this.#driver.all<JobRow>(
      `SELECT sha256, step, version, attempts FROM jobs
        WHERE state = 'pending'
          AND (next_at IS NULL OR next_at <= ?)
          AND (${current})
        ORDER BY created_at ASC, sha256 ASC
        LIMIT ?`,
      [this.#ports.now(), ...params, RUN_BATCH],
    );
  }

  async #prerequisitesFinished(sha256: string, step: Step): Promise<boolean> {
    for (const name of step.after) {
      const prerequisite = this.#steps.find((s) => s.name === name);
      if (prerequisite === undefined) continue;
      const rows = await this.#driver.all<{ state: JobState }>(
        'SELECT state FROM jobs WHERE sha256 = ? AND step = ? AND version = ?',
        [sha256, prerequisite.name, prerequisite.version],
      );
      const state = rows[0]?.state;
      if (state === undefined || !FINISHED.includes(state)) return false;
    }
    return true;
  }

  async #run(job: JobRow, step: Step): Promise<'done' | 'skipped' | 'given_up' | 'waiting'> {
    const now = this.#ports.now();
    const document = await this.#storage.record(job.sha256);
    if (document === null) {
      await this.#finish(job, 'given_up', 'the document is no longer stored');
      return 'given_up';
    }

    // Whether the step applies is asked first: a step that stopped applying while it
    // waited (OCR, once the phone's text arrives) is skipped at once, so whatever
    // comes after it does not sit out the rest of its wait.
    if (!(await step.applies(document))) {
      await this.#finish(job, 'skipped', null);
      return 'skipped';
    }

    const notBefore = await step.notBefore?.(document);
    if (notBefore !== undefined && now < notBefore) {
      // Looked at again every few seconds rather than only at its start time, so
      // the question above gets asked again while it waits.
      await this.#driver.run(
        'UPDATE jobs SET next_at = ? WHERE sha256 = ? AND step = ? AND version = ?',
        [Math.min(notBefore, now + RECHECK_MS), job.sha256, job.step, job.version],
      );
      return 'waiting';
    }

    await this.#driver.run(
      `UPDATE jobs SET state = 'running' WHERE sha256 = ? AND step = ? AND version = ?`,
      [job.sha256, job.step, job.version],
    );
    // Not caught: a throw is a crash (ADR 0005), and leaving the row `running` is
    // exactly the record the next tick needs to try again.
    const outcome = await step.run(document, { now });

    if (outcome.ok) {
      await this.#finish(job, 'done', null);
      return 'done';
    }
    return this.#failed(job, step, document, outcome.reason);
  }

  async #failed(
    job: JobRow,
    step: Step,
    document: DocumentRecord,
    reason: FailureReason,
  ): Promise<'given_up' | 'waiting'> {
    const attempts = job.attempts + 1;
    const spent = step.budget !== null && attempts >= step.budget;
    if (!isRetryable(reason) || spent) {
      // The hook runs before the job is marked, so a crash between them leaves the
      // job to be retried and the hook to run again, rather than a job given up on
      // with no final answer left behind.
      await step.onGiveUp?.(document, { now: this.#ports.now() });
      await this.#finish(job, 'given_up', describe(reason), attempts);
      return 'given_up';
    }
    await this.#driver.run(
      `UPDATE jobs SET state = 'pending', attempts = ?, next_at = ?, last_error = ?
        WHERE sha256 = ? AND step = ? AND version = ?`,
      [
        attempts,
        this.#ports.now() + backoffMs(attempts, this.#ports.jitter()),
        describe(reason),
        job.sha256,
        job.step,
        job.version,
      ],
    );
    return 'waiting';
  }

  async #finish(
    job: JobRow,
    state: 'done' | 'skipped' | 'given_up',
    error: string | null,
    attempts = job.attempts + (state === 'done' ? 1 : 0),
  ): Promise<void> {
    await this.#driver.run(
      `UPDATE jobs SET state = ?, attempts = ?, last_error = ?, next_at = NULL, finished_at = ?
        WHERE sha256 = ? AND step = ? AND version = ?`,
      [state, attempts, error, this.#ports.now(), job.sha256, job.step, job.version],
    );
  }
}

function describe(reason: FailureReason): string {
  return reason.kind === 'server_error' || reason.kind === 'auth' || reason.kind === 'rejected'
    ? `${reason.kind} (${String(reason.status)})`
    : reason.kind;
}
