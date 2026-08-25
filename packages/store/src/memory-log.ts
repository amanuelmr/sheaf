import type { CaptureEvent, DocId } from '@sheaf/core';
import type { EventLog, EventRecord } from './log.ts';

/** In-memory log, for tests and for the simulator. Same semantics as the SQL one. */
export class MemoryEventLog implements EventLog {
  private readonly records: EventRecord[] = [];

  append(events: readonly CaptureEvent[]): Promise<void> {
    for (const event of events) {
      this.records.push({ seq: this.records.length + 1, event });
    }
    return Promise.resolve();
  }

  replay(docId: DocId): Promise<readonly CaptureEvent[]> {
    return Promise.resolve(this.records.filter((r) => r.event.docId === docId).map((r) => r.event));
  }

  docIds(): Promise<readonly DocId[]> {
    const seen = new Set<DocId>();
    for (const record of this.records) seen.add(record.event.docId);
    return Promise.resolve([...seen]);
  }

  since(seq: number): Promise<readonly EventRecord[]> {
    return Promise.resolve(this.records.filter((r) => r.seq > seq));
  }

  count(): Promise<number> {
    return Promise.resolve(this.records.length);
  }
}
