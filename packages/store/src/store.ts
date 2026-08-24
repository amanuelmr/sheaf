import { reduce, type CaptureEvent, type DocId, type DocState } from '@sheaf/core';
import type { EventLog } from './log';
import { projectOutbox, type OutboxRow } from './outbox';
import { paperTrail, type TrailEntry } from './trail';

/**
 * Everything the app reads, derived from the log.
 *
 * There is no state table to keep in step, so nothing can disagree with the log.
 * If replay is ever too slow, a snapshot becomes a cache — not a second source of
 * truth.
 */
export class DocumentStore {
  /**
   * Memoised replay, keyed by document.
   *
   * `reduce` is pure and a document's log only ever grows through `commit`, so an
   * entry can only go stale when we ourselves append to that document — which makes
   * invalidation exact rather than a guess. This is a cache of a derivation, not a
   * second source of truth: throwing it away costs time and changes no answer.
   *
   * It exists because it had to. The sync loop calls `states()` every few seconds,
   * and replaying every document each time was quadratic: 0.9 ms at 50 documents,
   * 4.6 ms at 200, and 107 ms at 1,000 — a visible stall, every tick, mostly spent
   * re-deriving documents that synced months ago.
   */
  private readonly derived = new Map<DocId, DocState>();
  private knownIds: readonly DocId[] | null = null;

  constructor(private readonly log: EventLog) {}

  /** The only write path. */
  async commit(...events: readonly CaptureEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.log.append(events);
    for (const event of events) this.derived.delete(event.docId);
    this.knownIds = null;
  }

  /** Drop the memo. Only needed if something outside this store wrote to the log. */
  invalidate(): void {
    this.derived.clear();
    this.knownIds = null;
  }

  async state(docId: DocId): Promise<DocState | null> {
    const cached = this.derived.get(docId);
    if (cached !== undefined) return cached;

    const events = await this.log.replay(docId);
    if (events.length === 0) return null;
    const state = reduce(events);
    this.derived.set(docId, state);
    return state;
  }

  async states(): Promise<Map<DocId, DocState>> {
    this.knownIds ??= await this.log.docIds();
    const states = new Map<DocId, DocState>();
    for (const docId of this.knownIds) {
      const state = await this.state(docId);
      if (state !== null) states.set(docId, state);
    }
    return states;
  }

  async outbox(): Promise<readonly OutboxRow[]> {
    return projectOutbox((await this.states()).values());
  }

  async trail(docId: DocId): Promise<readonly TrailEntry[]> {
    return paperTrail(await this.log.replay(docId));
  }
}
