import {
  MAX_AUTO_ATTEMPTS,
  next,
  reduce,
  shouldAutoRetryOnReconnect,
  type CaptureEvent,
  type Command,
  type DocId,
  type DocState,
  type FailureReason,
  type NetStatus,
  type SyncPolicy,
} from '@sheaf/core';
import { interpretTask } from '@sheaf/paperless';
import { FakePaperless } from './fake-paperless';
import { rollAttempt, rollKill, rollOffline, type FaultProfile } from './faults';
import { rng, type Rng } from './random';
import { virtualClock, type VirtualClock } from './clock';

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
  readonly logs: Map<DocId, readonly CaptureEvent[]>;
  readonly steps: number;
  readonly converged: boolean;
  readonly uploads: Map<DocId, number>;
  readonly reconciles: number;
  readonly kills: number;
  /** Invariants breached during the run. A correct engine leaves this empty. */
  readonly violations: readonly string[];
}

const STEP_MS = 250;
const DEFAULT_MAX_STEPS = 4_000;

/**
 * Drives the pure engine through a hostile world on a virtual clock.
 *
 * Everything nondeterministic comes from the seed, so a failing seed is a
 * reproducible bug rather than a story about a flaky test.
 */
class Sim {
  private readonly clock: VirtualClock;
  private readonly rand: Rng;
  private readonly server: FakePaperless;
  private readonly logs = new Map<DocId, CaptureEvent[]>();
  private readonly uploads = new Map<DocId, number>();
  private readonly violations: string[] = [];
  private readonly policy: SyncPolicy;

  private net: NetStatus = 'wifi';
  private resuming = false;
  /** Set when the process died mid-request; the next step resumes. */
  private pendingResume = false;
  /** The process is gone for the rest of this step. */
  private dead = false;
  private progressed = false;
  private waitTargets: number[] = [];
  private reconciles = 0;
  private kills = 0;

  constructor(private readonly options: SimOptions) {
    this.clock = virtualClock(0);
    this.rand = rng(options.seed);
    this.server = new FakePaperless(options.consumeDelayMs ?? 500);
    this.policy = options.policy ?? { wifiOnly: false, keepLocalAfterSync: true };

    for (let i = 0; i < options.documents; i++) {
      // The content hash is the identity, so a synthetic hash per document is enough.
      const docId = `${options.seed}-${i}`.padStart(64, '0');
      const at = this.clock.now();
      this.logs.set(docId, [
        {
          type: 'Captured',
          docId,
          at,
          pages: [
            {
              id: `${docId}-p1`,
              path: `/d/${docId}.jpg`,
              width: 1700,
              height: 2200,
              bytes: 210_000,
            },
          ],
          sha256: docId,
          bytes: 210_000,
        },
        { type: 'Enqueued', docId, at, sha256: docId },
      ]);
      this.uploads.set(docId, 0);
    }
  }

  run(): SimResult {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let steps = 0;

    while (steps < maxSteps && !this.allSettled()) {
      steps += 1;
      this.progressed = false;
      this.waitTargets = [];

      // A restart carries over from a kill that interrupted a request last step.
      this.resuming = this.pendingResume;
      this.pendingResume = false;
      this.dead = false;

      if (rollKill(this.options.faults, this.rand, this.clock.now())) {
        // Killed while idle. State is replayed from the log; nothing was in flight.
        this.resuming = true;
        this.kills += 1;
      }

      // Consumption progresses whether or not a client is watching.
      this.server.advanceTo(this.clock.now());

      this.net = rollOffline(this.options.faults, this.rand, this.clock.now())
        ? 'offline'
        : this.rand.chance(0.3)
          ? 'cellular'
          : 'wifi';

      for (const docId of this.shuffledDocIds()) {
        if (this.isDead()) break; // nothing else runs after the process dies
        this.stepDocument(docId);
      }

      this.resuming = false;
      if (!this.madeProgress()) this.advanceClock();
    }

    const states = new Map<DocId, DocState>();
    for (const [docId, log] of this.logs) states.set(docId, reduce(log));

    return {
      server: this.server,
      states,
      logs: this.logs,
      steps,
      converged: this.allSettled(),
      uploads: this.uploads,
      reconciles: this.reconciles,
      kills: this.kills,
      violations: this.violations,
    };
  }

  private stepDocument(docId: DocId): void {
    let state = reduce(this.log(docId));

    // Once the world is healthy again, a stalled document gets another chance:
    // the user fixes their token, or connectivity returning re-arms a retry.
    if (this.clock.now() >= this.options.faults.healAtMs) {
      if (state.status === 'BLOCKED' || shouldAutoRetryOnReconnect(state)) {
        this.append({ type: 'RetryRequested', docId, at: this.clock.now() });
        state = reduce(this.log(docId));
      }
    }

    const command = next(state, {
      now: this.clock.now(),
      net: this.net,
      policy: this.policy,
      resuming: this.resuming,
    });

    this.execute(command, state);
  }

  private execute(command: Command, state: DocState): void {
    const now = this.clock.now();
    const docId = state.docId;

    switch (command.type) {
      case 'upload': {
        if (state.taskId !== null) {
          this.violations.push(
            `${docId}: uploaded while task ${state.taskId} was still outstanding`,
          );
        }
        this.uploads.set(docId, (this.uploads.get(docId) ?? 0) + 1);
        const attempt = state.attempts + 1;
        this.append({ type: 'UploadStarted', docId, at: now, attempt });
        this.applyAttemptFault(docId, attempt);
        return;
      }

      case 'pollTask': {
        const outcome = interpretTask(this.server.task(command.taskId));
        if (outcome === 'pending') return; // let the clock move on
        this.append({ type: 'ServerConfirmed', docId, at: now, outcome });
        return;
      }

      case 'reconcile': {
        this.reconciles += 1;
        const found = this.server.findByHash(command.sha256);
        if (found) {
          // The bytes did land. Discovering this costs one lookup, not a re-upload.
          this.append({
            type: 'ServerConfirmed',
            docId,
            at: now,
            outcome: { kind: 'stored', remoteId: found.id },
          });
          return;
        }
        // It never landed. Fold it back into the retry path.
        this.append({
          type: 'UploadFailed',
          docId,
          at: now,
          attempt: Math.max(1, state.attempts),
          reason: { kind: 'unreachable' },
          jitter: this.rand.next(),
        });
        return;
      }

      case 'fetchSuggestions': {
        this.append({
          type: 'SuggestionsReceived',
          docId,
          at: now,
          suggestions: { title: `Document ${command.remoteId}`, documentType: 'Receipt' },
        });
        if (this.rand.chance(0.5)) {
          this.append({
            type: 'MetadataAccepted',
            docId,
            at: now,
            patch: { title: `Document ${command.remoteId}` },
          });
        }
        return;
      }

      case 'patchMetadata': {
        const patched = this.server.patch(command.remoteId, {
          title: command.patch.title,
          correspondentId: command.patch.correspondentId,
          documentTypeId: command.patch.documentTypeId,
          tagIds: command.patch.tagIds,
        });
        if (!patched) this.violations.push(`${docId}: patched a document the server lacks`);
        this.append({ type: 'MetadataPatched', docId, at: now });
        return;
      }

      case 'releaseLocalFiles': {
        if (!this.server.has(state.sha256)) {
          this.violations.push(`${docId}: released local files for a document not on the server`);
        }
        this.append({ type: 'LocalFilesReleased', docId, at: now });
        return;
      }

      case 'wait': {
        if (command.untilMs !== null) this.waitTargets.push(command.untilMs);
        return;
      }

      case 'idle':
        return;
    }
  }

  private applyAttemptFault(docId: DocId, attempt: number): void {
    const now = this.clock.now();

    if (rollKill(this.options.faults, this.rand, now)) {
      // The process dies between logging the attempt and logging its outcome.
      // The log now ends at UploadStarted, so on resume the engine cannot know
      // whether the bytes landed -- which is exactly the spec's crash scenario.
      // Half the time they did land, and reconciliation has to notice.
      if (this.rand.chance(0.5)) this.server.post(docId, now);
      this.pendingResume = true;
      this.dead = true;
      this.kills += 1;
      return;
    }

    const fault = rollAttempt(this.options.faults, this.rand, now);
    const fail = (reason: FailureReason): void => {
      this.append({
        type: 'UploadFailed',
        docId,
        at: now,
        attempt,
        reason,
        jitter: this.rand.next(),
      });
    };

    switch (fault) {
      case 'dropRequest':
        fail({ kind: 'unreachable' });
        return;
      case 'serverError':
        fail({ kind: 'server_error', status: 503 });
        return;
      case 'authError':
        fail({ kind: 'auth', status: 401 });
        return;
      case 'rateLimited':
        fail({ kind: 'rate_limited', retryAfterMs: 3_000 });
        return;
      case 'lostResponse':
        // The server accepts the document and the client never hears back. The
        // bytes are safe; the client has no idea. This is the case that breaks
        // naive uploaders.
        this.server.post(docId, now);
        fail({ kind: 'unreachable' });
        return;
      case 'none': {
        const taskId = this.server.post(docId, now);
        this.append({ type: 'TaskAccepted', docId, at: now, taskId });
        return;
      }
    }
  }

  private allSettled(): boolean {
    for (const log of this.logs.values()) {
      const state = reduce(log);
      if (state.status !== 'SYNCED') return false;
      const command = next(state, {
        now: this.clock.now(),
        net: 'wifi',
        policy: this.policy,
        resuming: false,
      });
      if (command.type !== 'idle') return false;
    }
    return true;
  }

  private advanceClock(): void {
    const now = this.clock.now();
    const due = this.waitTargets.filter((t) => t > now);
    const target = due.length > 0 ? Math.min(...due) : now + STEP_MS;
    this.clock.advance(Math.max(STEP_MS, target - now));
  }

  // Read through accessors: these flags are mutated inside stepDocument, which
  // the compiler's control-flow analysis cannot see from the run loop.
  private isDead(): boolean {
    return this.dead;
  }

  private madeProgress(): boolean {
    return this.progressed;
  }

  private shuffledDocIds(): DocId[] {
    const ids = [...this.logs.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = this.rand.int(i + 1);
      const a = ids[i]!;
      ids[i] = ids[j]!;
      ids[j] = a;
    }
    return ids;
  }

  private log(docId: DocId): CaptureEvent[] {
    const log = this.logs.get(docId);
    if (!log) throw new Error(`unknown document ${docId}`);
    return log;
  }

  private append(event: CaptureEvent): void {
    this.log(event.docId).push(event);
    this.progressed = true;
  }
}

export function runSim(options: SimOptions): SimResult {
  return new Sim(options).run();
}

/** A deterministic list of seeds, so a suite covers the same schedules every run. */
export function seeds(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

export { MAX_AUTO_ATTEMPTS };
