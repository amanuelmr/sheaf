import {
  shouldAutoRetryOnReconnect,
  type Command,
  type DocId,
  type DocState,
  type NetStatus,
  type SyncPolicy,
} from '@sheaf/core';
import { SyncEngine, type EnginePorts, type UploadAccepted } from '@sheaf/engine';
import { err, ok, type ApiResult } from '@sheaf/http';
import { DocumentStore, MemoryEventLog, type EventLog } from '@sheaf/store';
import { interpretTask } from '@sheaf/paperless';
import { FakePaperless } from './fake-paperless.ts';
import { rollAttempt, rollKill, rollOffline, rollSideTask, type FaultProfile } from './faults.ts';
import { rng, type Rng } from './random.ts';
import { virtualClock, type VirtualClock } from './clock.ts';

export interface SimOptions {
  readonly seed: number;
  readonly documents: number;
  readonly faults: FaultProfile;
  readonly maxSteps?: number;
  readonly policy?: SyncPolicy;
  readonly consumeDelayMs?: number;
}

export interface SimResult {
  readonly server: FakePaperless;
  readonly states: Map<DocId, DocState>;
  readonly log: EventLog;
  readonly steps: number;
  readonly converged: boolean;
  readonly uploads: Map<DocId, number>;
  readonly reconciles: number;
  readonly kills: number;
  /** How often post-sync work was attempted. Bounded, or the engine is looping. */
  readonly sideTaskCalls: number;
  /** Invariants breached during the run. A correct engine leaves this empty. */
  readonly violations: readonly string[];
}

const STEP_MS = 250;
const DEFAULT_MAX_STEPS = 4_000;

/** Thrown by a port when the process dies mid-request. Never caught by the engine. */
class ProcessKilled extends Error {
  constructor() {
    super('process killed mid-request');
  }
}

/**
 * Drives the REAL engine through a hostile world on a virtual clock.
 *
 * The faults live in the ports, not in a parallel copy of the executor. That
 * matters: an earlier version of this file re-implemented the upload loop, so the
 * suite could have gone on passing while the shipping engine drifted away from it.
 * Now the only thing simulated is the world.
 */
class Sim {
  private readonly clock: VirtualClock;
  private readonly rand: Rng;
  private readonly server: FakePaperless;
  private readonly log = new MemoryEventLog();
  private readonly store = new DocumentStore(this.log);
  private readonly engine: SyncEngine;
  private readonly policy: SyncPolicy;
  private readonly uploads = new Map<DocId, number>();
  private readonly violations: string[] = [];
  private readonly docIds: DocId[] = [];

  private net: NetStatus = 'wifi';
  private resuming = false;
  private pendingResume = false;
  private dead = false;
  private waitTargets: number[] = [];
  private reconciles = 0;
  private kills = 0;
  private sideTaskCalls = 0;

  constructor(private readonly options: SimOptions) {
    this.clock = virtualClock(0);
    this.rand = rng(options.seed);
    this.server = new FakePaperless(options.consumeDelayMs ?? 500);
    this.policy = options.policy ?? { wifiOnly: false, keepLocalAfterSync: true };
    this.engine = new SyncEngine(this.store, this.ports());

    for (let i = 0; i < options.documents; i++) {
      const docId = `${options.seed}-${i}`.padStart(64, '0');
      this.docIds.push(docId);
      this.uploads.set(docId, 0);
    }
  }

  async run(): Promise<SimResult> {
    // The shutter fires for every document before anything is sent.
    for (const docId of this.docIds) {
      await this.engine.capture({
        docId,
        sha256: docId,
        bytes: 210_000,
        pages: [
          { id: `${docId}-p1`, path: `/d/${docId}.jpg`, width: 1700, height: 2200, bytes: 210_000 },
        ],
      });
    }

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let steps = 0;

    while (steps < maxSteps && !(await this.allSettled())) {
      steps += 1;
      this.waitTargets = [];
      const before = await this.log.count();

      this.resuming = this.pendingResume;
      this.pendingResume = false;
      this.dead = false;

      if (rollKill(this.options.faults, this.rand, this.clock.now())) {
        this.resuming = true; // killed while idle: nothing was in flight
        this.kills += 1;
      }

      // Consumption progresses whether or not a client is watching.
      this.server.advanceTo(this.clock.now());

      this.net = rollOffline(this.options.faults, this.rand, this.clock.now())
        ? 'offline'
        : this.rand.chance(0.3)
          ? 'cellular'
          : 'wifi';

      for (const docId of this.shuffled()) {
        if (this.isDead()) break; // nothing else runs after the process dies
        await this.stepDocument(docId);
      }

      this.resuming = false;
      if ((await this.log.count()) === before) this.advanceClock();
    }

    return {
      server: this.server,
      states: await this.store.states(),
      log: this.log,
      steps,
      converged: await this.allSettled(),
      uploads: this.uploads,
      reconciles: this.reconciles,
      kills: this.kills,
      sideTaskCalls: this.sideTaskCalls,
      violations: this.violations,
    };
  }

  private async stepDocument(docId: DocId): Promise<void> {
    const state = await this.store.state(docId);
    if (state === null) return;

    // Once the world is healthy again, a stalled document gets another chance: the
    // user fixes their token, or connectivity returning re-arms a retry.
    if (this.clock.now() >= this.options.faults.healAtMs) {
      if (state.status === 'BLOCKED' || shouldAutoRetryOnReconnect(state)) {
        await this.engine.requestRetry(docId);
        return;
      }
    }

    // Sometimes the user accepts what Paperless suggested.
    if (state.suggestions !== null && state.metadata === null && this.rand.chance(0.3)) {
      await this.engine.acceptMetadata(docId, { title: `Document ${state.remoteId ?? 0}` });
      return;
    }

    try {
      const command = await this.engine.tick(docId, this.resuming);
      this.noteWait(command);
    } catch (error) {
      if (!(error instanceof ProcessKilled)) throw error;
      // The log ends at UploadStarted. That is the spec's crash scenario.
    }
  }

  private noteWait(command: Command | null): void {
    if (command?.type === 'wait' && command.untilMs !== null) {
      this.waitTargets.push(command.untilMs);
    }
  }

  private ports(): EnginePorts {
    return {
      now: () => this.clock.now(),
      jitter: () => this.rand.next(),
      net: () => this.net,
      policy: () => this.policy,
      api: {
        postDocument: (state) => Promise.resolve(this.post(state)),
        pollTask: (taskId) => Promise.resolve(ok(interpretTask(this.server.task(taskId)))),
        findByCaptureId: (sha256) => {
          this.reconciles += 1;
          return Promise.resolve(ok(this.server.findByHash(sha256)?.id ?? null));
        },
        getSuggestions: (remoteId) => {
          this.sideTaskCalls += 1;
          const fault = rollSideTask(this.options.faults, this.rand);
          if (fault === 'permanent') return Promise.resolve(err({ kind: 'not_found' }));
          if (fault === 'transient') return Promise.resolve(err({ kind: 'unreachable' }));
          return Promise.resolve(ok({ title: `Document ${remoteId}`, documentType: 'Receipt' }));
        },
        patchDocument: (remoteId, patch) => {
          // The simulated server assigns serial numbers, so anything else is a bug
          // in the wiring rather than a case to handle.
          if (typeof remoteId !== 'number') {
            this.violations.push(`patch called with a non-numeric id: ${String(remoteId)}`);
            return Promise.resolve(ok(null));
          }
          this.sideTaskCalls += 1;
          const fault = rollSideTask(this.options.faults, this.rand);
          if (fault === 'permanent')
            return Promise.resolve(err({ kind: 'rejected', status: 400, message: 'no' }));
          if (fault === 'transient') return Promise.resolve(err({ kind: 'unreachable' }));
          const applied = this.server.patch(remoteId, {
            title: patch.title,
            correspondentId: patch.correspondentId,
            documentTypeId: patch.documentTypeId,
            tagIds: patch.tagIds,
          });
          if (!applied)
            this.violations.push(`patched document ${remoteId}, which the server lacks`);
          return Promise.resolve(ok(null));
        },
      },
      files: {
        release: (state) => {
          if (!this.server.has(state.sha256)) {
            this.violations.push(
              `${state.docId}: released local files for a document not on the server`,
            );
          }
          return Promise.resolve();
        },
      },
    };
  }

  private post(state: DocState): ApiResult<UploadAccepted> {
    const now = this.clock.now();

    if (state.taskId !== null) {
      this.violations.push(`${state.docId}: uploaded while task ${state.taskId} was outstanding`);
    }
    this.uploads.set(state.docId, (this.uploads.get(state.docId) ?? 0) + 1);

    if (rollKill(this.options.faults, this.rand, now)) {
      // Dies between the attempt being logged and its outcome being logged. Half
      // the time the bytes landed anyway, and reconciliation has to notice.
      if (this.rand.chance(0.5)) this.server.post(state.sha256, now);
      this.pendingResume = true;
      this.dead = true;
      this.kills += 1;
      throw new ProcessKilled();
    }

    switch (rollAttempt(this.options.faults, this.rand, now)) {
      case 'dropRequest':
        return err({ kind: 'unreachable' });
      case 'serverError':
        return err({ kind: 'server_error', status: 503 });
      case 'authError':
        return err({ kind: 'auth', status: 401 });
      case 'rateLimited':
        return err({ kind: 'rate_limited', retryAfterMs: 3_000 });
      case 'lostResponse':
        // The server accepts it and the client never hears back. The bytes are
        // safe; the client has no idea. This is what breaks naive uploaders.
        this.server.post(state.sha256, now);
        return err({ kind: 'unreachable' });
      case 'none':
        return ok({ kind: 'task' as const, taskId: this.server.post(state.sha256, now) });
    }
  }

  // Read through an accessor: `dead` is set inside a port call, which the
  // compiler's control-flow analysis cannot see from the run loop.
  private isDead(): boolean {
    return this.dead;
  }

  private async allSettled(): Promise<boolean> {
    for (const state of (await this.store.states()).values()) {
      if (state.status !== 'SYNCED') return false;
      // Work the engine has rightly given up on counts as settled: the document
      // itself is confirmed, which is what actually matters.
      if (state.suggestions === null && state.side.suggestions.abandoned === null) return false;
      if (
        state.metadata !== null &&
        !state.metadataPatched &&
        state.side.metadata.abandoned === null
      ) {
        return false;
      }
      if (!this.policy.keepLocalAfterSync && state.localFilesPresent) return false;
    }
    return true;
  }

  private advanceClock(): void {
    const now = this.clock.now();
    const due = this.waitTargets.filter((t) => t > now);
    const target = due.length > 0 ? Math.min(...due) : now + STEP_MS;
    this.clock.advance(Math.max(STEP_MS, target - now));
  }

  private shuffled(): DocId[] {
    const ids = [...this.docIds];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = this.rand.int(i + 1);
      const a = ids[i]!;
      ids[i] = ids[j]!;
      ids[j] = a;
    }
    return ids;
  }
}

export function runSim(options: SimOptions): Promise<SimResult> {
  return new Sim(options).run();
}

/** A deterministic list of seeds, so a suite covers the same schedules every run. */
export function seeds(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}
