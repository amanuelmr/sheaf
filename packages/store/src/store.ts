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
  constructor(private readonly log: EventLog) {}

  /** The only write path. */
  async commit(...events: readonly CaptureEvent[]): Promise<void> {
    await this.log.append(events);
  }

  async state(docId: DocId): Promise<DocState | null> {
    const events = await this.log.replay(docId);
    return events.length === 0 ? null : reduce(events);
  }

  async states(): Promise<Map<DocId, DocState>> {
    const states = new Map<DocId, DocState>();
    for (const docId of await this.log.docIds()) {
      const events = await this.log.replay(docId);
      if (events.length > 0) states.set(docId, reduce(events));
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
