import type { CaptureEvent, DocId } from '@sheaf/core';

export interface EventRecord {
  /** Monotonic append order across all documents. */
  readonly seq: number;
  readonly event: CaptureEvent;
}

/**
 * The durable append-only log. The only writes are appends; there is no update and
 * no delete, which is what makes replay of any prefix a valid state.
 */
export interface EventLog {
  /** Append atomically: either every event lands or none does. */
  append(events: readonly CaptureEvent[]): Promise<void>;
  replay(docId: DocId): Promise<readonly CaptureEvent[]>;
  docIds(): Promise<readonly DocId[]>;
  since(seq: number): Promise<readonly EventRecord[]>;
  count(): Promise<number>;
}
