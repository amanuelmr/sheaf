import { describe as suite, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { next } from '../src/machine';
import { isSynced, mayBeOnServer, needsUser } from '../src/state';
import type { CaptureEvent } from '../src/events';
import {
  DOC,
  ONLINE,
  accepted,
  captured,
  confirmed,
  enqueued,
  failed,
  page,
  started,
} from './helpers';

suite('page editing while a capture is still a draft', () => {
  it('adds, replaces, and removes pages', () => {
    const edited = { ...page('p1'), path: '/docs/p1-cropped.jpg', bytes: 190_000 };
    const s = reduce([
      captured(),
      { type: 'PageAdded', docId: DOC, at: 1_100, page: page('p2') },
      { type: 'PageReplaced', docId: DOC, at: 1_200, page: edited },
      { type: 'PageRemoved', docId: DOC, at: 1_300, pageId: 'p2' },
    ]);
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]!.path).toBe('/docs/p1-cropped.jpg');
    expect(next(s, ONLINE)).toEqual({ type: 'idle', docId: DOC });
  });

  it('treats a replacement of an unknown page as an addition', () => {
    const s = reduce([
      captured(),
      { type: 'PageReplaced', docId: DOC, at: 1_100, page: page('p9') },
    ]);
    expect(s.pages.map((p) => p.id)).toEqual(['p1', 'p9']);
  });

  it('refuses page edits once the hash is fixed', () => {
    const frozen: CaptureEvent[] = [captured(), enqueued()];
    expect(
      reduce([...frozen, { type: 'PageRemoved', docId: DOC, at: 2_000, pageId: 'p1' }]).pages,
    ).toHaveLength(1);
    expect(
      reduce([...frozen, { type: 'PageReplaced', docId: DOC, at: 2_000, page: page('p1') }]).pages,
    ).toHaveLength(1);
    // Enqueuing twice must not reopen it either.
    expect(reduce([...frozen, enqueued(3_000)]).status).toBe('QUEUED');
  });
});

suite('metadata and retention', () => {
  const synced: CaptureEvent[] = [
    captured(),
    enqueued(),
    started(1, 2_000),
    accepted('t-1', 2_100),
    confirmed({ kind: 'stored', remoteId: 4821 }, 2_200),
  ];

  it('merges successive metadata edits and marks them unsent again', () => {
    const s = reduce([
      ...synced,
      { type: 'MetadataAccepted', docId: DOC, at: 3_000, patch: { title: 'Receipt' } },
      { type: 'MetadataPatched', docId: DOC, at: 3_100 },
      {
        type: 'MetadataAccepted',
        docId: DOC,
        at: 3_200,
        patch: { tags: ['shopping', 'utilities'] },
      },
    ]);
    expect(s.metadata).toEqual({ title: 'Receipt', tags: ['shopping', 'utilities'] });
    expect(s.metadataPatched).toBe(false);
  });

  it('releases local files only once the server has confirmed', () => {
    const s = reduce([...synced, { type: 'LocalFilesReleased', docId: DOC, at: 4_000 }]);
    expect(s.localFilesPresent).toBe(false);
    expect(next(s, { ...ONLINE, policy: { wifiOnly: false, keepLocalAfterSync: false } })).toEqual({
      type: 'fetchSuggestions',
      docId: DOC,
      remoteId: 4821,
    });
  });

  it('reports a consumer refusal as a failure that keeps the local copy', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      accepted('t-1', 2_100),
      confirmed({ kind: 'consumer_failed', message: 'unsupported file type' }, 2_200),
    ]);
    expect(s.status).toBe('FAILED');
    expect(s.lastError).toEqual({ kind: 'rejected', status: 0, message: 'unsupported file type' });
    expect(s.localFilesPresent).toBe(true);
  });

  it('records giving up without discarding anything', () => {
    const s = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_100),
      { type: 'GaveUp', docId: DOC, at: 9_000, reason: { kind: 'unreachable' } },
    ]);
    expect(s.status).toBe('FAILED');
    expect(s.localFilesPresent).toBe(true);
    expect(next(s, ONLINE)).toEqual({ type: 'idle', docId: DOC });
  });
});

suite('state predicates', () => {
  it('distinguishes "needs the user" from "might already be on the server"', () => {
    const draft = reduce([captured()]);
    expect(needsUser(draft)).toBe(false);
    expect(mayBeOnServer(draft)).toBe(false);
    expect(isSynced(draft)).toBe(false);

    const inFlight = reduce([captured(), enqueued(), started(1, 2_000)]);
    expect(mayBeOnServer(inFlight)).toBe(true);

    const blocked = reduce([
      captured(),
      enqueued(),
      started(1, 2_000),
      failed(1, 2_100, { kind: 'auth', status: 401 }),
    ]);
    expect(needsUser(blocked)).toBe(true);
    expect(mayBeOnServer(blocked)).toBe(false);
  });
});

suite('awaiting the server', () => {
  it('waits rather than polling while offline', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000), accepted('t-1', 2_100)]);
    expect(next(s, { ...ONLINE, net: 'offline' })).toEqual({
      type: 'wait',
      docId: DOC,
      untilMs: null,
    });
  });

  it('reconciles a backoff document that is due while offline by waiting', () => {
    const s = reduce([captured(), enqueued(), started(1, 2_000), failed(1, 2_500)]);
    expect(next(s, { ...ONLINE, now: 99_999, net: 'offline' })).toEqual({
      type: 'wait',
      docId: DOC,
      untilMs: null,
    });
  });
});
