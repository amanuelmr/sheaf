/**
 * The acceptance test the whole architecture exists to pass (spec §51).
 *
 *   User scans 10 documents. #1 and #2 upload. #3 is mid-upload. The app dies.
 *   On reopen: #1 and #2 synced, #3 recoverable, #4-#10 waiting. Nothing lost.
 *
 * Rather than testing that one crash point, we truncate the log at EVERY record
 * boundary and assert the invariants hold for all of them — because that is what
 * a crash actually does to an append-only log.
 */
import { describe as suite, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { next } from '../src/machine';
import { mayBeOnServer } from '../src/state';
import type { CaptureEvent, DocId } from '../src/events';
import type { DocState } from '../src/state';

const DOCS: DocId[] = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(64, '0'));

/** The log as it stood the instant the process died. */
function buildLog(): CaptureEvent[] {
  const log: CaptureEvent[] = [];
  let t = 1_000;
  const tick = () => (t += 10);

  for (const docId of DOCS) {
    log.push({
      type: 'Captured',
      docId,
      at: tick(),
      pages: [
        { id: `${docId}-p1`, path: `/d/${docId}.jpg`, width: 1700, height: 2200, bytes: 210_000 },
      ],
      sha256: docId,
      bytes: 210_000,
    });
    log.push({ type: 'Enqueued', docId, at: tick(), sha256: docId });
  }

  // #1 and #2 make it all the way.
  for (const docId of DOCS.slice(0, 2)) {
    log.push({ type: 'UploadStarted', docId, at: tick(), attempt: 1 });
    log.push({ type: 'TaskAccepted', docId, at: tick(), taskId: `task-${docId}` });
    log.push({
      type: 'ServerConfirmed',
      docId,
      at: tick(),
      outcome: { kind: 'stored', remoteId: Number(docId) },
    });
  }

  // #3 is in flight. Nothing follows: this is where the process died.
  log.push({ type: 'UploadStarted', docId: DOCS[2]!, at: tick(), attempt: 1 });
  return log;
}

const RESUME = {
  now: 100_000,
  net: 'wifi',
  policy: { wifiOnly: false, keepLocalAfterSync: true },
  resuming: true,
} as const;

function replayAll(log: readonly CaptureEvent[]): Map<DocId, DocState> {
  const byDoc = new Map<DocId, CaptureEvent[]>();
  for (const e of log) {
    const bucket = byDoc.get(e.docId);
    if (bucket) bucket.push(e);
    else byDoc.set(e.docId, [e]);
  }
  const states = new Map<DocId, DocState>();
  for (const [docId, events] of byDoc) states.set(docId, reduce(events));
  return states;
}

suite('crash recovery', () => {
  const log = buildLog();

  it('recovers the exact expected picture after dying mid-upload', () => {
    const states = replayAll(log);
    expect(states.size).toBe(10);

    expect(states.get(DOCS[0]!)!.status).toBe('SYNCED');
    expect(states.get(DOCS[1]!)!.status).toBe('SYNCED');

    // #3 is not "failed" and not "lost" — it is unknown, and therefore recoverable.
    const third = states.get(DOCS[2]!)!;
    expect(third.status).toBe('UPLOADING');
    expect(next(third, RESUME)).toEqual({ type: 'reconcile', docId: DOCS[2], sha256: DOCS[2] });

    for (const docId of DOCS.slice(3)) {
      expect(states.get(docId)!.status).toBe('QUEUED');
    }
  });

  it('loses nothing and duplicates nothing at any truncation point', () => {
    for (let cut = 1; cut <= log.length; cut++) {
      const states = replayAll(log.slice(0, cut));

      for (const [docId, state] of states) {
        // Every document that was ever captured still has a local copy.
        if (state.status !== 'SYNCED') {
          expect(state.localFilesPresent, `doc ${docId} lost its local copy at cut ${cut}`).toBe(
            true,
          );
        }

        // The exactly-once invariant: if the bytes might be on the server, no tick
        // may produce an upload.
        if (mayBeOnServer(state)) {
          for (const resuming of [true, false]) {
            const cmd = next(state, { ...RESUME, resuming });
            expect(cmd.type, `doc ${docId} would re-upload at cut ${cut}`).not.toBe('upload');
          }
        }
      }
    }
  });

  it('is deterministic: replaying the same log twice yields the same state', () => {
    expect(replayAll(log)).toEqual(replayAll(log));
  });

  it('tolerates a duplicated tail, as an at-least-once writer would produce', () => {
    const doubled = [...log, log[log.length - 1]!];
    expect(replayAll(doubled).get(DOCS[2]!)!.status).toBe('UPLOADING');
  });
});
