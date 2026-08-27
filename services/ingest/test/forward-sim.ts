/**
 * Deterministic simulation for the second hop.
 *
 * The phone's hop has had a hostile simulator since early on. This one did not,
 * and the asymmetry stopped being defensible once the hand-off moved here: a
 * capture is now declared safe after one short upload, which means "never lose a
 * document" is a promise the *server* keeps. It was being tested by thirteen unit
 * tests against a fake driven by hand -- each one a scenario somebody thought of.
 *
 * What follows is the same construction as `@sheaf/sim`: a real `Forwarder` writing
 * to real `Storage`, a virtual clock, seeded randomness, and faults injected into
 * the target. The process is killed mid-hand-off and restarted, which is the case
 * no hand-written scenario covers well, because the interesting part is precisely
 * the instant nobody thinks to write a test for.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FailureReason } from '@sheaf/core';
import { err, ok } from '@sheaf/http';
import { interpretTask } from '@sheaf/paperless';
import type { DocumentRecord } from '@sheaf/protocol';
import { FakePaperless, rng, rollAttempt, rollKill, virtualClock } from '@sheaf/sim';
import type { FaultProfile, Rng, VirtualClock } from '@sheaf/sim';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Forwarder, type ForwardTarget } from '../src/forwarder.ts';
import { Storage, sha256Hex } from '../src/storage.ts';

const STEP_MS = 1_000;
const IDLE_SKIP_MS = 30_000;
const DEFAULT_MAX_STEPS = 600;

export interface ForwardSimOptions {
  readonly seed: number;
  readonly documents: number;
  readonly faults: FaultProfile;
  readonly maxSteps?: number;
  readonly consumeDelayMs?: number;
}

export interface ForwardSimResult {
  readonly paperless: FakePaperless;
  readonly records: readonly DocumentRecord[];
  readonly steps: number;
  /** Every document handed on. Documents that legitimately gave up do not count. */
  readonly converged: boolean;
  readonly sends: number;
  /** Times the process died mid-hand-off and came back to find its own mess. */
  readonly crashes: number;
  /** Hand-offs the target accepted while we were told they had failed. */
  readonly lostResponses: number;
  readonly violations: readonly string[];
}

/** Thrown by the target when the process dies mid-request. Never caught. */
class ProcessKilled extends Error {
  constructor() {
    super('process killed mid-hand-off');
  }
}

/**
 * Fault profiles for this hop.
 *
 * `authError` is zero throughout, and not because it cannot happen: a rotated token
 * is correctly non-retryable, so injecting one would have the forwarder give up as
 * designed, and "did every document arrive" would be the wrong question to then ask.
 * It is covered by a unit test, where a deterministic answer is the point.
 */
export const FORWARD_FLAKY: FaultProfile = {
  offline: 0,
  dropRequest: 0.15,
  lostResponse: 0.15,
  serverError: 0.1,
  authError: 0,
  rateLimited: 0.05,
  kill: 0.06,
  sideTaskError: 0,
  healAtMs: 30_000,
};

export const FORWARD_HOSTILE: FaultProfile = {
  offline: 0,
  dropRequest: 0.3,
  lostResponse: 0.3,
  serverError: 0.2,
  authError: 0,
  rateLimited: 0.1,
  kill: 0.15,
  sideTaskError: 0,
  healAtMs: 45_000,
};

class ForwardSim {
  private readonly clock: VirtualClock;
  private readonly rand: Rng;
  private readonly paperless: FakePaperless;
  private readonly hashes: string[] = [];
  private readonly violations: string[] = [];
  private readonly payloads = new Map<string, Uint8Array>();

  private sends = 0;
  private crashes = 0;
  private lostResponses = 0;

  // Written out rather than a constructor parameter property: the ingest service
  // runs under Node's type stripping, and this file sits in the same package.
  private readonly options: ForwardSimOptions;

  constructor(options: ForwardSimOptions) {
    this.options = options;
    this.clock = virtualClock(0);
    this.rand = rng(options.seed);
    this.paperless = new FakePaperless(options.consumeDelayMs ?? 2_000);
  }

  async run(): Promise<ForwardSimResult> {
    const storage = await Storage.open({
      driver: nodeSqliteDriver(),
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-fwdsim-')),
    });

    for (let i = 0; i < this.options.documents; i++) {
      const bytes = new Uint8Array(
        Buffer.from(`%PDF-1.4\nsheaf sim ${this.options.seed}/${i}\n%%EOF\n`),
      );
      const hash = sha256Hex(bytes);
      this.hashes.push(hash);
      this.payloads.set(hash, bytes);
      await storage.put(hash, bytes, this.clock.now(), 1);
    }

    const ports = { now: () => this.clock.now(), jitter: () => this.rand.next() };
    // Rebuilt after every crash, which is what a restarted process gets. Storage is
    // deliberately NOT rebuilt: the database and the objects survive, and everything
    // the forwarder is allowed to remember has to have been written down.
    let forwarder = new Forwarder(storage, this.target(), ports);

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let steps = 0;

    while (steps < maxSteps && !(await this.settled(storage))) {
      steps += 1;
      // Consumption runs on the target's own clock, whether or not we are watching.
      this.paperless.advanceTo(this.clock.now());

      let examined = 0;
      try {
        examined = (await forwarder.tick()).examined;
      } catch (error) {
        if (!(error instanceof ProcessKilled)) throw error;
        this.crashes += 1;
        forwarder = new Forwarder(storage, this.target(), ports);
      }

      // Nothing was due, so a real scheduler would be asleep rather than spinning.
      // Skipping ahead keeps a five-minute backoff from costing five minutes of
      // steps, without making the schedule any less deterministic.
      this.clock.advance(examined === 0 ? IDLE_SKIP_MS : STEP_MS);
    }

    this.paperless.advanceTo(this.clock.now());
    const records = await storage.list();
    this.check(storage, records);

    return {
      paperless: this.paperless,
      records,
      steps,
      converged: records.every((r) => r.forward.state === 'done'),
      sends: this.sends,
      crashes: this.crashes,
      lostResponses: this.lostResponses,
      violations: this.violations,
    };
  }

  private target(): ForwardTarget {
    return {
      send: (document, bytes) => {
        this.sends += 1;
        if (sha256Hex(bytes) !== document.sha256) {
          this.violations.push(`${document.sha256}: sent bytes that are not the document`);
        }

        if (this.kill()) {
          // Dies after the target took the bytes and before we could write down
          // that we sent them. On restart there is a hand-off in flight that
          // nothing in our database mentions.
          this.paperless.post(document.sha256, this.clock.now());
          throw new ProcessKilled();
        }

        const fault = rollAttempt(this.options.faults, this.rand, this.clock.now());
        if (fault === 'lostResponse') {
          // Accepted, and we are told otherwise. Same hole, reached by a different
          // route: we will back off and try again while it is already on its way in.
          this.lostResponses += 1;
          this.paperless.post(document.sha256, this.clock.now());
          return Promise.resolve(err({ kind: 'unreachable' }));
        }
        const refused = this.refusal(fault);
        if (refused !== null) return Promise.resolve(err(refused));

        return Promise.resolve(ok(this.paperless.post(document.sha256, this.clock.now())));
      },

      poll: (taskId) => {
        if (this.kill()) throw new ProcessKilled();
        const refused = this.refusal(rollAttempt(this.options.faults, this.rand, this.clock.now()));
        if (refused !== null) return Promise.resolve(err(refused));

        const task = this.paperless.task(taskId);
        if (task === null) return Promise.resolve(ok(null));
        const outcome = interpretTask(task);
        return Promise.resolve(ok(outcome));
      },

      locate: (sha256) => {
        if (this.kill()) throw new ProcessKilled();
        const refused = this.refusal(rollAttempt(this.options.faults, this.rand, this.clock.now()));
        if (refused !== null) return Promise.resolve(err(refused));

        const found = this.paperless.findByHash(sha256);
        return Promise.resolve(ok(found === null ? null : String(found.id)));
      },

      locateTask: (sha256) => {
        if (this.kill()) throw new ProcessKilled();
        const refused = this.refusal(rollAttempt(this.options.faults, this.rand, this.clock.now()));
        if (refused !== null) return Promise.resolve(err(refused));

        return Promise.resolve(ok(this.paperless.findTaskByHash(sha256)));
      },
    };
  }

  private kill(): boolean {
    return rollKill(this.options.faults, this.rand, this.clock.now());
  }

  /** Turns an attempt fault into the failure the target would have reported. */
  private refusal(fault: ReturnType<typeof rollAttempt>): FailureReason | null {
    switch (fault) {
      case 'dropRequest':
        return { kind: 'unreachable' };
      case 'serverError':
        return { kind: 'server_error', status: 503 };
      case 'rateLimited':
        return { kind: 'rate_limited', retryAfterMs: 3_000 };
      case 'authError':
        return { kind: 'auth', status: 401 };
      case 'none':
      case 'lostResponse':
        // Neither is a refusal: `none` succeeded, and a lost reply is handled where
        // it happens, because only the caller knows the bytes went out first.
        return null;
    }
  }

  private async settled(storage: Storage): Promise<boolean> {
    const records = await storage.list();
    return records.every((r) => r.forward.state === 'done' || r.forward.state === 'failed');
  }

  /** What has to be true afterwards, whatever the schedule was. */
  private check(storage: Storage, records: readonly DocumentRecord[]): void {
    for (const hash of this.hashes) {
      const copies = this.paperless.copiesOf(hash);
      if (copies > 1) {
        this.violations.push(`${hash.slice(0, 8)}: forwarded ${copies} times, so it exists twice`);
      }

      // Forwarding is metadata. Whatever happened to the hand-off, the document we
      // accepted is still exactly the document we accepted.
      const stored = storage.bytes(hash);
      const original = this.payloads.get(hash)!;
      if (stored === null || Buffer.compare(Buffer.from(stored), Buffer.from(original)) !== 0) {
        this.violations.push(`${hash.slice(0, 8)}: the stored bytes did not survive forwarding`);
      }
    }

    for (const record of records) {
      if (record.forward.state === 'done') {
        if (!this.paperless.has(record.sha256)) {
          this.violations.push(`${record.sha256.slice(0, 8)}: marked done but the target lacks it`);
        }
        if (record.forward.remoteId === null) {
          this.violations.push(`${record.sha256.slice(0, 8)}: done without learning its name`);
        }
      }
      if (record.forward.state === 'failed' && record.forward.error === null) {
        this.violations.push(`${record.sha256.slice(0, 8)}: gave up without saying why`);
      }
    }
  }
}

export function runForwardSim(options: ForwardSimOptions): Promise<ForwardSimResult> {
  return new ForwardSim(options).run();
}

export function forwardSeeds(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}
