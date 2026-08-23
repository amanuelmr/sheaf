import { describe as suite, expect, it } from 'vitest';
import { next, shouldAutoRetryOnReconnect } from '../src/machine';
import { reduce } from '../src/reduce';
import {
  accepted,
  captured,
  confirmed,
  enqueued,
  failed,
  started,
  DOC,
  OFFLINE,
  ONLINE,
} from './helpers';
import type { CaptureEvent } from '../src/events';

suite('next', () => {
  it('uploads a queued document when the server is reachable', () => {
    const s = reduce([captured(), enqueued()]);
    expect(next(s, ONLINE)).toEqual({ type: 'upload', docId: DOC });
  });

  it('waits instead of failing when offline', () => {
    const s = reduce([captured(), enqueued()]);
    expect(next(s, OFFLINE)).toEqual({ type: 'wait', docId: DOC, untilMs: null });
  });

  it('respects the Wi-Fi-only policy', () => {
    const s = reduce([captured(), enqueued()]);
    const cellular = {
      ...ONLINE,
      net: 'cellular' as const,
      policy: { wifiOnly: true, keepLocalAfterSync: true },
    };
    expect(next(s, cellular).type).toBe('wait');
  });

  it('holds off until the backoff expires, then uploads', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000), failed(1, 2_500)]);
    expect(next(s, { ...ONLINE, now: 3_000 })).toEqual({
      type: 'wait',
      docId: DOC,
      untilMs: 3_500,
    });
    expect(next(s, { ...ONLINE, now: 3_500 }).type).toBe('upload');
  });

  it('reconciles rather than re-uploads after a crash mid-request', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000)]);
    expect(next(s, { ...ONLINE, resuming: true })).toEqual({
      type: 'reconcile',
      docId: DOC,
      sha256: s.sha256,
    });
  });

  it('polls an accepted task and never uploads again', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000), accepted('t-1', 2_100)]);
    expect(next(s, ONLINE)).toEqual({ type: 'pollTask', docId: DOC, taskId: 't-1' });
    // The invariant, stated as a test: no tick can coax an upload out of this state.
    for (const net of ['offline', 'cellular', 'wifi'] as const) {
      for (const resuming of [true, false]) {
        for (const wifiOnly of [true, false]) {
          const cmd = next(s, {
            now: 99_999,
            net,
            resuming,
            policy: { wifiOnly, keepLocalAfterSync: true },
          });
          expect(cmd.type).not.toBe('upload');
        }
      }
    }
  });

  it('does nothing for a blocked document — waiting will not fix a bad token', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_100, { kind: 'auth', status: 401 }),
    ]);
    expect(next(s, ONLINE)).toEqual({ type: 'idle', docId: DOC });
  });

  it('pulls suggestions once the document is on the server', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('t-1', 2_100),
      confirmed({ kind: 'stored', remoteId: 4821 }, 2_200),
    ]);
    expect(next(s, ONLINE)).toEqual({ type: 'fetchSuggestions', docId: DOC, remoteId: 4821 });
  });

  it('patches accepted metadata before anything else', () => {
    const events: CaptureEvent[] = [
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('t-1', 2_100),
      confirmed({ kind: 'stored', remoteId: 4821 }, 2_200),
      { type: 'MetadataAccepted', docId: DOC, at: 3_000, patch: { title: 'Amazon receipt' } },
    ];
    expect(next(reduce(events), ONLINE)).toEqual({
      type: 'patchMetadata',
      docId: DOC,
      remoteId: 4821,
      patch: { title: 'Amazon receipt' },
    });
  });

  it('keeps local files unless the retention policy says otherwise', () => {
    const events: CaptureEvent[] = [
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('t-1', 2_100),
      confirmed({ kind: 'stored', remoteId: 4821 }, 2_200),
      { type: 'SuggestionsReceived', docId: DOC, at: 2_300, suggestions: {} },
    ];
    const s = reduce(events);
    expect(next(s, ONLINE).type).toBe('idle');
    expect(next(s, { ...ONLINE, policy: { wifiOnly: false, keepLocalAfterSync: false } })).toEqual({
      type: 'releaseLocalFiles',
      docId: DOC,
    });
  });
});

suite('shouldAutoRetryOnReconnect', () => {
  it('offers a free retry to documents the network defeated', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_100, { kind: 'too_large' }),
    ]);
    expect(shouldAutoRetryOnReconnect(s)).toBe(false);

    const events: CaptureEvent[] = [captured(), enqueued()];
    for (let a = 1; a <= 5; a++) events.push(started(a, 1_000 * a), failed(a, 1_000 * a + 10));
    expect(shouldAutoRetryOnReconnect(reduce(events))).toBe(true);
  });
});
