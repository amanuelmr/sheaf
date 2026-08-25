import type { CaptureEvent, DocId } from '@sheaf/core';
import type { SqlDriver } from './driver.ts';
import type { EventLog, EventRecord } from './log.ts';

interface Row {
  seq: number;
  payload: string;
}

/**
 * The durable log. One INSERT per event, inside one transaction per append, so a
 * kill mid-batch leaves either all of the batch or none of it — never half an
 * event.
 */
export class SqlEventLog implements EventLog {
  constructor(private readonly driver: SqlDriver) {}

  async append(events: readonly CaptureEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.driver.transaction(async () => {
      for (const event of events) {
        await this.driver.run(
          'INSERT INTO capture_log (doc_id, at, type, payload) VALUES (?, ?, ?, ?)',
          [event.docId, event.at, event.type, JSON.stringify(event)],
        );
      }
    });
  }

  async replay(docId: DocId): Promise<readonly CaptureEvent[]> {
    const rows = await this.driver.all<Row>(
      'SELECT seq, payload FROM capture_log WHERE doc_id = ? ORDER BY seq ASC',
      [docId],
    );
    return rows.map((row) => parse(row.payload));
  }

  async docIds(): Promise<readonly DocId[]> {
    const rows = await this.driver.all<{ doc_id: string }>(
      'SELECT doc_id FROM capture_log GROUP BY doc_id ORDER BY MIN(seq) ASC',
    );
    return rows.map((row) => row.doc_id);
  }

  async since(seq: number): Promise<readonly EventRecord[]> {
    const rows = await this.driver.all<Row>(
      'SELECT seq, payload FROM capture_log WHERE seq > ? ORDER BY seq ASC',
      [seq],
    );
    return rows.map((row) => ({ seq: row.seq, event: parse(row.payload) }));
  }

  async count(): Promise<number> {
    const rows = await this.driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM capture_log');
    return rows[0]?.n ?? 0;
  }
}

function parse(payload: string): CaptureEvent {
  return JSON.parse(payload) as CaptureEvent;
}
