/**
 * Post-sync work — fetching suggestions, saving details — is optional enrichment on
 * a document that is already safe. It therefore has to be able to fail and *stop*.
 *
 * These tests exist because it could not. A server answering 404 on the suggestions
 * endpoint was re-asked on every tick, for every synced document, for ever: 198
 * requests in 200 ticks in the probe that found it.
 */
import { describe as suite, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { next } from '../src/machine';
import { MAX_AUTO_ATTEMPTS } from '../src/backoff';
import type { CaptureEvent } from '../src/events';
import { accepted, captured, confirmed, enqueued, started, DOC, ONLINE } from './helpers';

const synced: CaptureEvent[] = [
  captured(),
  enqueued(),
  started(1, 2_000),
  accepted('t-1', 2_100),
  confirmed({ kind: 'stored', remoteId: 4821 }, 2_200),
];

const sideFailed = (
  task: 'suggestions' | 'metadata',
  attempt: number,
  at: number,
  reason: CaptureEvent extends never
    ? never
    : Extract<CaptureEvent, { type: 'SideTaskFailed' }>['reason'] = {
    kind: 'unreachable',
  },
): CaptureEvent => ({ type: 'SideTaskFailed', docId: DOC, at, task, attempt, reason, jitter: 0 });

suite('suggestions that fail', () => {
  it('backs off instead of asking again immediately', () => {
    const state = reduce([...synced, sideFailed('suggestions', 1, 3_000)]);
    expect(state.side.suggestions.attempts).toBe(1);
    expect(state.side.suggestions.nextAttemptAt).toBe(4_000);
    expect(next(state, { ...ONLINE, now: 3_500 })).toEqual({
      type: 'wait',
      docId: DOC,
      untilMs: 4_000,
    });
    expect(next(state, { ...ONLINE, now: 4_000 }).type).toBe('fetchSuggestions');
  });

  it('stops for good on a refusal that retrying cannot change', () => {
    // An older Paperless with no suggestions endpoint answers 404 every time.
    const state = reduce([...synced, sideFailed('suggestions', 1, 3_000, { kind: 'not_found' })]);
    expect(state.side.suggestions.abandoned).toEqual({ kind: 'not_found' });
    expect(next(state, { ...ONLINE, now: 9_999_999 })).toEqual({ type: 'idle', docId: DOC });
  });

  it('stops after the budget, however patient the network problem', () => {
    const events = [...synced];
    for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
      events.push(sideFailed('suggestions', attempt, 3_000 + attempt * 1_000));
    }
    const state = reduce(events);
    expect(state.side.suggestions.abandoned).toEqual({ kind: 'unreachable' });
    expect(next(state, { ...ONLINE, now: 9_999_999 }).type).toBe('idle');
  });

  it('forgets the failures as soon as suggestions do arrive', () => {
    const state = reduce([
      ...synced,
      sideFailed('suggestions', 1, 3_000),
      { type: 'SuggestionsReceived', docId: DOC, at: 5_000, suggestions: { title: 'Receipt' } },
    ]);
    expect(state.side.suggestions).toEqual({ attempts: 0, nextAttemptAt: null, abandoned: null });
  });
});

suite('details that fail to save', () => {
  const accepted_ = (at: number): CaptureEvent => ({
    type: 'MetadataAccepted',
    docId: DOC,
    at,
    patch: { title: 'Amazon receipt' },
  });

  it('backs off, then gives up, without ever touching the document itself', () => {
    const events = [...synced, accepted_(3_000)];
    for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
      events.push(sideFailed('metadata', attempt, 4_000 + attempt * 1_000));
    }
    const state = reduce(events);
    expect(state.status).toBe('SYNCED');
    expect(state.remoteId).toBe(4821);
    expect(state.side.metadata.abandoned).not.toBeNull();
    expect(state.metadataPatched).toBe(false);
    // It moves on to the work it has not given up on, rather than retrying this.
    expect(next(state, { ...ONLINE, now: 9_999_999 }).type).toBe('fetchSuggestions');

    const settled = reduce([
      ...events,
      { type: 'SuggestionsReceived', docId: DOC, at: 20_000, suggestions: {} },
    ]);
    expect(next(settled, { ...ONLINE, now: 9_999_999 }).type).toBe('idle');
  });

  it('does not let abandoned details keep the local copy hostage', () => {
    // The document is confirmed on the server, which is what retention depends on.
    const events = [
      ...synced,
      accepted_(3_000),
      sideFailed('metadata', 1, 4_000, { kind: 'not_found' }),
    ];
    const state = reduce([
      ...events,
      { type: 'SuggestionsReceived', docId: DOC, at: 5_000, suggestions: {} },
    ]);
    expect(
      next(state, { ...ONLINE, policy: { wifiOnly: false, keepLocalAfterSync: false } }),
    ).toEqual({ type: 'releaseLocalFiles', docId: DOC });
  });

  it('gives a fresh budget when the user chooses details again', () => {
    const state = reduce([
      ...synced,
      accepted_(3_000),
      sideFailed('metadata', 1, 4_000, { kind: 'not_found' }),
      accepted_(9_000),
    ]);
    expect(state.side.metadata.abandoned).toBeNull();
    expect(next(state, { ...ONLINE, now: 9_100 }).type).toBe('patchMetadata');
  });

  it('lets the user retry a synced document without re-uploading it', () => {
    const state = reduce([
      ...synced,
      accepted_(3_000),
      sideFailed('metadata', 1, 4_000, { kind: 'not_found' }),
      { type: 'RetryRequested', docId: DOC, at: 9_000 },
    ]);
    expect(state.status).toBe('SYNCED');
    expect(state.side.metadata.abandoned).toBeNull();
    expect(next(state, { ...ONLINE, now: 9_100 }).type).toBe('patchMetadata');
  });
});
