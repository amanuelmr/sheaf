import { describe as suite, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { MAX_AUTO_ATTEMPTS } from '../src/backoff';
import { accepted, captured, confirmed, enqueued, failed, started, DOC } from './helpers';
import type { CaptureEvent } from '../src/events';

suite('reduce', () => {
  it('requires the log to begin with a Captured event', () => {
    expect(() => reduce([])).toThrow(/must begin with a Captured event/);
    expect(() => reduce([enqueued()])).toThrow(/must begin with a Captured event/);
  });

  it('starts a capture as an editable draft with local files present', () => {
    const s = reduce([captured()]);
    expect(s.status).toBe('DRAFT');
    expect(s.pages).toHaveLength(1);
    expect(s.localFilesPresent).toBe(true);
    expect(s.remoteId).toBeNull();
  });

  it('freezes pages once the hash is fixed at Enqueued', () => {
    const s = reduce([
      captured(),
      enqueued(),
      {
        type: 'PageAdded',
        docId: DOC,
        at: 1_002,
        page: { ...{ id: 'p2', path: '/p2', width: 1, height: 1, bytes: 1 } },
      },
    ]);
    expect(s.status).toBe('QUEUED');
    expect(s.pages).toHaveLength(1);
  });

  it('schedules a backoff after a retryable failure', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000), failed(1, 2_500)]);
    expect(s.status).toBe('BACKOFF');
    expect(s.attempts).toBe(1);
    expect(s.nextAttemptAt).toBe(2_500 + 1_000); // half of the 2s rung, zero jitter
  });

  it('honours Retry-After over the backoff ladder', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_500, { kind: 'rate_limited', retryAfterMs: 90_000 }),
    ]);
    expect(s.nextAttemptAt).toBe(92_500);
  });

  it('blocks rather than retries when only the user can fix it', () => {
    for (const reason of [
      { kind: 'auth', status: 401 },
      { kind: 'not_found' },
      { kind: 'tls', detail: 'self signed' },
    ] as const) {
      const s = reduce([captured(), enqueued(), started(1, 2_000), failed(1, 2_500, reason)]);
      expect(s.status).toBe('BLOCKED');
      expect(s.nextAttemptAt).toBeNull();
    }
  });

  it('gives up after the automatic attempt budget, without losing the document', () => {
    const events: CaptureEvent[] = [captured(), enqueued()];
    for (let a = 1; a <= MAX_AUTO_ATTEMPTS; a++) {
      events.push(started(a, 2_000 * a), failed(a, 2_000 * a + 100));
    }
    const s = reduce(events);
    expect(s.status).toBe('FAILED');
    expect(s.localFilesPresent).toBe(true);
  });

  it('treats a duplicate rejection as proof the server already has it', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('task-1', 2_100),
      confirmed({ kind: 'duplicate', remoteId: 4821 }, 2_200),
    ]);
    expect(s.status).toBe('SYNCED');
    expect(s.remoteId).toBe(4821);
    expect(s.lastError).toBeNull();
  });

  it('ignores upload events that arrive after confirmation', () => {
    const base: CaptureEvent[] = [
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('task-1', 2_100),
      confirmed({ kind: 'stored', remoteId: 7 }, 2_200),
    ];
    const s = reduce([...base, started(2, 3_000), failed(2, 3_100)]);
    expect(s.status).toBe('SYNCED');
    expect(s.remoteId).toBe(7);
  });

  it('refuses to re-arm a document the server may already hold', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('task-1', 2_100),
      { type: 'RetryRequested', docId: DOC, at: 2_200 },
    ]);
    expect(s.status).toBe('AWAITING_SERVER');
    expect(s.taskId).toBe('task-1');
  });

  it('re-arms a failed document when the user asks', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_100, { kind: 'auth', status: 401 }),
      { type: 'RetryRequested', docId: DOC, at: 5_000 },
    ]);
    expect(s.status).toBe('QUEUED');
    expect(s.attempts).toBe(0);
  });

  it('never records a local-file release for an unconfirmed document', () => {
    const s = reduce([
      captured(),
      enqueued(),
      { type: 'LocalFilesReleased', docId: DOC, at: 3_000 },
    ]);
    expect(s.localFilesPresent).toBe(true);
  });
});
