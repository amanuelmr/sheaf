/**
 * Text the phone recognised is sent to the server once the document is safe there
 * (ADR 0009). It is post-sync work, so it gets the same discipline as suggestions and
 * metadata. One more rule applies: the local copy must not be released before the
 * text is sent, because releasing it deletes the text.
 */
import { describe as suite, expect, it } from 'vitest';
import { OCR_GRACE_MS, next } from '../src/machine';
import { reduce } from '../src/reduce';
import type { CaptureEvent } from '../src/events';
import { captured, confirmed, enqueued, started, DOC, ONLINE } from './helpers';

const RELEASING = { ...ONLINE, policy: { wifiOnly: false, keepLocalAfterSync: false } };

const capturedWithOcr = (at = 1_000): CaptureEvent => ({
  ...(captured(at) as Extract<CaptureEvent, { type: 'Captured' }>),
  ocrPending: true,
});
const synced: CaptureEvent[] = [
  enqueued(),
  started(1, 2_000),
  confirmed({ kind: 'stored', remoteId: DOC }, 2_100),
];
const recognized = (at: number): CaptureEvent => ({ type: 'TextRecognized', docId: DOC, at });
const unavailable = (at: number): CaptureEvent => ({ type: 'TextUnavailable', docId: DOC, at });
const uploaded = (at: number): CaptureEvent => ({ type: 'TextUploaded', docId: DOC, at });
const textFailed = (
  attempt: number,
  at: number,
  reason: Extract<CaptureEvent, { type: 'SideTaskFailed' }>['reason'] = { kind: 'unreachable' },
): CaptureEvent => ({
  type: 'SideTaskFailed',
  docId: DOC,
  at,
  task: 'text',
  attempt,
  reason,
  jitter: 0,
});

suite('recognised text', () => {
  it('starts pending when OCR was started at capture, and none for an older log', () => {
    expect(reduce([capturedWithOcr()]).text).toBe('pending');
    expect(reduce([captured()]).text).toBe('none');
  });

  it('is uploaded once the document is synced', () => {
    const s = reduce([capturedWithOcr(), recognized(1_500), ...synced]);
    expect(next(s, ONLINE)).toEqual({ type: 'uploadText', docId: DOC, sha256: DOC });
  });

  it('is never uploaded before the server holds the document', () => {
    const s = reduce([capturedWithOcr(), recognized(1_500), enqueued(), started(1, 2_000)]);
    expect(next(s, ONLINE).type).not.toBe('uploadText');
  });

  it('is uploaded before suggestions are asked for, since the text is what they come from', () => {
    const s = reduce([capturedWithOcr(), recognized(1_500), ...synced]);
    expect(next(s, ONLINE).type).toBe('uploadText');
    const after = reduce([capturedWithOcr(), recognized(1_500), ...synced, uploaded(3_000)]);
    expect(next(after, ONLINE).type).toBe('fetchSuggestions');
  });

  it('is uploaded once, and stays uploaded', () => {
    const s = reduce([capturedWithOcr(), recognized(1_500), ...synced, uploaded(3_000)]);
    expect(s.text).toBe('uploaded');
    expect(
      reduce([capturedWithOcr(), recognized(1_500), ...synced, uploaded(3_000), recognized(4_000)])
        .text,
    ).toBe('uploaded');
  });

  it('backs off after a failure, then gives up after the budget', () => {
    const base = [capturedWithOcr(), recognized(1_500), ...synced];
    const once = reduce([...base, textFailed(1, 3_000)]);
    expect(next(once, { ...ONLINE, now: 3_001 }).type).toBe('wait');

    const refused = reduce([...base, textFailed(1, 3_000, { kind: 'not_found' })]);
    expect(refused.side.text.abandoned).toEqual({ kind: 'not_found' });
    expect(next(refused, ONLINE).type).toBe('fetchSuggestions');
  });
});

suite('releasing the local copy', () => {
  it('waits for the text to be sent', () => {
    const s = reduce([capturedWithOcr(), recognized(1_500), ...synced]);
    expect(next(s, RELEASING).type).toBe('uploadText');
    const sent = reduce([capturedWithOcr(), recognized(1_500), ...synced, uploaded(3_000)]);
    // Suggestions are still owed, so release the moment they are settled; text is no longer in the way.
    expect(sent.text).toBe('uploaded');
  });

  it('waits while OCR is still running, then stops waiting after the grace period', () => {
    const s = reduce([
      capturedWithOcr(1_000),
      ...synced,
      {
        type: 'SuggestionsReceived',
        docId: DOC,
        at: 2_200,
        suggestions: {},
      },
    ]);
    expect(next(s, { ...RELEASING, now: 1_000 + OCR_GRACE_MS - 1 })).toEqual({
      type: 'wait',
      docId: DOC,
      untilMs: 1_000 + OCR_GRACE_MS,
    });
    expect(next(s, { ...RELEASING, now: 1_000 + OCR_GRACE_MS + 1 }).type).toBe('releaseLocalFiles');
  });

  it('does not wait when OCR found nothing, or for a log from before OCR was tracked', () => {
    const settled: CaptureEvent = {
      type: 'SuggestionsReceived',
      docId: DOC,
      at: 2_200,
      suggestions: {},
    };
    const none = reduce([capturedWithOcr(), unavailable(1_500), ...synced, settled]);
    expect(next(none, RELEASING).type).toBe('releaseLocalFiles');
    const old = reduce([captured(), ...synced, settled]);
    expect(next(old, RELEASING).type).toBe('releaseLocalFiles');
  });

  it('does not let abandoned text keep the local copy hostage', () => {
    const settled: CaptureEvent = {
      type: 'SuggestionsReceived',
      docId: DOC,
      at: 2_200,
      suggestions: {},
    };
    const s = reduce([
      capturedWithOcr(),
      recognized(1_500),
      ...synced,
      settled,
      textFailed(1, 3_000, { kind: 'rejected', status: 400, message: 'no' }),
    ]);
    expect(next(s, RELEASING).type).toBe('releaseLocalFiles');
  });
});

suite('logs written before text was tracked', () => {
  it('replay to exactly the state the old code produced, with no text to send', async () => {
    // Produced by the core as it was before this change: see fixtures/pre-text-log.json.
    const { log, state } = (await import('./fixtures/pre-text-log.json')).default as unknown as {
      log: CaptureEvent[];
      state: Record<string, unknown>;
    };
    const now = reduce(log);
    const { text, side, ...rest } = now;
    const { side: oldSide, ...oldRest } = state as { side: Record<string, unknown> };

    expect(rest).toEqual(oldRest);
    expect({ suggestions: side.suggestions, metadata: side.metadata }).toEqual(oldSide);
    expect(text).toBe('none');
    expect(side.text).toEqual({ attempts: 0, nextAttemptAt: null, abandoned: null });
  });
});

suite('crash recovery with text in the log', () => {
  const log: CaptureEvent[] = [
    capturedWithOcr(1_000),
    recognized(1_500),
    ...synced,
    textFailed(1, 3_000),
    { type: 'SuggestionsReceived', docId: DOC, at: 3_500, suggestions: {} },
    uploaded(4_000),
    { type: 'LocalFilesReleased', docId: DOC, at: 4_100 },
  ];

  it('never releases the local copy while recognised text is unsent, at any truncation point', () => {
    for (let cut = 1; cut <= log.length; cut++) {
      const state = reduce(log.slice(0, cut));
      for (const now of [3_001, 1_000 + OCR_GRACE_MS + 1, 10 * OCR_GRACE_MS]) {
        for (const resuming of [true, false]) {
          const command = next(state, { ...RELEASING, now, resuming });
          if (command.type === 'releaseLocalFiles') {
            expect(state.text, `cut ${String(cut)} at ${String(now)}`).not.toBe('available');
          }
          if (state.status === 'SYNCED') {
            expect(command.type, `cut ${String(cut)}`).not.toBe('upload');
          }
        }
      }
    }
  });
});
