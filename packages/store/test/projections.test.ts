import { describe as suite, expect, it } from 'vitest';
import { reduce, type CaptureEvent, type DocState } from '@sheaf/core';
import { DocumentStore } from '../src/store';
import { MemoryEventLog } from '../src/memory-log';
import { pendingCount, projectOutbox, toOutboxRow } from '../src/outbox';
import { paperTrail } from '../src/trail';
import { DOC_A, DOC_B, fullLife, page } from './events';

const base = (docId: string): CaptureEvent[] => [
  { type: 'Captured', docId, at: 1_000, pages: [page('p1')], sha256: docId, bytes: 210_000 },
  { type: 'Enqueued', docId, at: 1_000, sha256: docId },
];

const stateFrom = (events: readonly CaptureEvent[]): DocState => reduce(events);

suite('outbox rows', () => {
  it('never relies on colour alone to say what is happening', () => {
    // Spec §41: a symbol and a sentence, so a screen reader learns what an eye does.
    const cases: CaptureEvent[][] = [
      [...base(DOC_A)],
      [...base(DOC_A), { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 }],
      [
        ...base(DOC_A),
        { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
        { type: 'TaskAccepted', docId: DOC_A, at: 2_100, taskId: 'task-1' },
      ],
      [
        ...base(DOC_A),
        { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
        {
          type: 'UploadFailed',
          docId: DOC_A,
          at: 2_100,
          attempt: 1,
          reason: { kind: 'unreachable' },
          jitter: 0,
        },
      ],
      [
        ...base(DOC_A),
        { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
        {
          type: 'UploadFailed',
          docId: DOC_A,
          at: 2_100,
          attempt: 1,
          reason: { kind: 'auth', status: 401 },
          jitter: 0,
        },
      ],
      [...fullLife(DOC_A)],
    ];

    for (const events of cases) {
      const row = toOutboxRow(stateFrom(events));
      expect(row.symbol, row.status).toBeTruthy();
      expect(row.label.length, row.status).toBeGreaterThan(0);
      expect(row.label, row.status).not.toMatch(/^(red|green|amber)$/i);
    }
  });

  it('reassures the user on every state where the document has not arrived', () => {
    const queued = toOutboxRow(stateFrom(base(DOC_A)));
    expect(queued.detail).toMatch(/safely on this device/i);

    const failed = toOutboxRow(
      stateFrom([
        ...base(DOC_A),
        { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
        { type: 'GaveUp', docId: DOC_A, at: 2_100, reason: { kind: 'unreachable' } },
      ]),
    );
    expect(failed.label).toBe('Sync failed');
    expect(failed.detail).toMatch(/safe on this device/i);
    expect(failed.actionable).toBe(true);
  });

  it('marks only the rows the user can act on', () => {
    const blocked = stateFrom([
      ...base(DOC_A),
      { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
      {
        type: 'UploadFailed',
        docId: DOC_A,
        at: 2_100,
        attempt: 1,
        reason: { kind: 'auth', status: 401 },
        jitter: 0,
      },
    ]);
    expect(toOutboxRow(blocked).actionable).toBe(true);
    expect(toOutboxRow(stateFrom(base(DOC_A))).actionable).toBe(false);
    expect(toOutboxRow(stateFrom(fullLife(DOC_A))).actionable).toBe(false);
  });

  it('puts what needs attention first and what is done last', () => {
    const blocked = stateFrom([
      ...base(DOC_A),
      { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
      {
        type: 'UploadFailed',
        docId: DOC_A,
        at: 2_100,
        attempt: 1,
        reason: { kind: 'auth', status: 401 },
        jitter: 0,
      },
    ]);
    const queued = stateFrom(base(DOC_B));
    const synced = stateFrom(fullLife('c'.repeat(64)));

    const rows = projectOutbox([synced, queued, blocked]);
    expect(rows.map((r) => r.status)).toEqual(['BLOCKED', 'QUEUED', 'SYNCED']);
  });

  it('counts what is still on its way, for the number under the shutter', () => {
    const rows = projectOutbox([
      stateFrom(base(DOC_A)),
      stateFrom(base(DOC_B)),
      stateFrom(fullLife('c'.repeat(64))),
    ]);
    expect(pendingCount(rows)).toBe(2);
    expect(pendingCount([])).toBe(0);
  });
});

suite('paper trail', () => {
  it('narrates a document’s whole life in plain language', () => {
    const entries = paperTrail(fullLife());
    const text = entries.map((e) => e.text);
    expect(text[0]).toBe('Captured (2 pages)');
    expect(text).toContain('Queued to send');
    expect(text).toContain('Upload attempt 1');
    expect(text).toContain("Attempt 1 failed — couldn't reach your server.");
    expect(text).toContain('Your server confirmed it — #4821');
    expect(text).toContain('Details saved to your server');
    expect(entries.map((e) => e.at)).toEqual(fullLife().map((e) => e.at));
  });

  it('shortens the task id instead of showing a raw uuid', () => {
    const entry = paperTrail(fullLife()).find((e) => e.text.startsWith('Accepted'))!;
    expect(entry.text).toBe('Accepted by your server (task a3f9c1d2…)');
  });

  it('says plainly when the server already had the document', () => {
    const docId = DOC_A;
    const withId = paperTrail([
      {
        type: 'ServerConfirmed',
        docId,
        at: 1,
        outcome: { kind: 'duplicate', remoteId: 77 },
      },
    ]);
    expect(withId[0]!.text).toBe('Your server already had this document (#77)');

    const withoutId = paperTrail([
      { type: 'ServerConfirmed', docId, at: 1, outcome: { kind: 'duplicate', remoteId: null } },
    ]);
    expect(withoutId[0]!.text).toBe('Your server already had this document');
  });

  it('marks the moments worth noticing', () => {
    const notable = paperTrail(fullLife())
      .filter((e) => e.notable)
      .map((e) => e.text);
    expect(notable).toContain('Captured (2 pages)');
    expect(notable).toContain('Your server confirmed it — #4821');
    expect(notable).not.toContain('Upload attempt 1');
  });

  it('has something to say about every event type', () => {
    for (const entry of paperTrail(fullLife())) {
      expect(entry.text.length, JSON.stringify(entry)).toBeGreaterThan(3);
    }
  });

  it('never renders a document as having been given up on silently', () => {
    const trail = paperTrail([
      { type: 'GaveUp', docId: DOC_A, at: 1, reason: { kind: 'unreachable' } },
    ]);
    expect(trail[0]!.text).toMatch(/still saved on this device/);
  });
});

suite('DocumentStore', () => {
  const store = () => new DocumentStore(new MemoryEventLog());

  it('is the only write path, and reads everything back off the log', async () => {
    const s = store();
    await s.commit(...fullLife(DOC_A));
    await s.commit(...base(DOC_B));

    expect((await s.state(DOC_A))!.status).toBe('SYNCED');
    expect((await s.state(DOC_B))!.status).toBe('QUEUED');
    expect(await s.state('missing')).toBeNull();
    expect((await s.states()).size).toBe(2);
  });

  it('projects an outbox and a trail without a second source of truth', async () => {
    const s = store();
    await s.commit(...base(DOC_A));
    await s.commit(...fullLife(DOC_B));

    const rows = await s.outbox();
    expect(rows.map((r) => r.status)).toEqual(['QUEUED', 'SYNCED']);
    expect(await s.trail(DOC_B)).toHaveLength(14);
    expect(await s.trail('missing')).toEqual([]);
  });
});

suite('post-sync failures are visible, not silent', () => {
  const synced: CaptureEvent[] = [
    ...base(DOC_A),
    { type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 },
    { type: 'TaskAccepted', docId: DOC_A, at: 2_100, taskId: 'task-1' },
    {
      type: 'ServerConfirmed',
      docId: DOC_A,
      at: 2_200,
      outcome: { kind: 'stored', remoteId: 4821 },
    },
  ];

  it('says so when the document arrived but the details did not', () => {
    const row = toOutboxRow(
      stateFrom([
        ...synced,
        { type: 'MetadataAccepted', docId: DOC_A, at: 3_000, patch: { title: 'Amazon' } },
        {
          type: 'SideTaskFailed',
          docId: DOC_A,
          at: 3_100,
          task: 'metadata',
          attempt: 1,
          reason: { kind: 'not_found' },
          jitter: 0,
        },
      ]),
    );
    expect(row.status).toBe('SYNCED');
    expect(row.symbol).toBe('⚠');
    expect(row.label).toBe('Synced — details not saved');
    // The distinction that matters: the document is fine, only the details are not.
    expect(row.detail).toMatch(/document is on your server/i);
    expect(row.actionable).toBe(true);
  });

  it('stays a plain success when only the suggestions failed', () => {
    // The user never asked for suggestions, so their absence is not their problem.
    const row = toOutboxRow(
      stateFrom([
        ...synced,
        {
          type: 'SideTaskFailed',
          docId: DOC_A,
          at: 3_000,
          task: 'suggestions',
          attempt: 1,
          reason: { kind: 'not_found' },
          jitter: 0,
        },
      ]),
    );
    expect(row.label).toBe('Synced');
    expect(row.actionable).toBe(false);
  });

  it('records both kinds of failure in the trail, in plain language', () => {
    const trail = paperTrail([
      {
        type: 'SideTaskFailed',
        docId: DOC_A,
        at: 1,
        task: 'suggestions',
        attempt: 1,
        reason: { kind: 'not_found' },
        jitter: 0,
      },
      {
        type: 'SideTaskFailed',
        docId: DOC_A,
        at: 2,
        task: 'metadata',
        attempt: 2,
        reason: { kind: 'unreachable' },
        jitter: 0,
      },
    ]);
    expect(trail[0]!.text).toBe(
      "Couldn't get suggestions — that address doesn't look like a Sheaf server.",
    );
    expect(trail[0]!.notable).toBe(false);
    expect(trail[1]!.text).toBe("Couldn't save your details — couldn't reach your server.");
    expect(trail[1]!.notable).toBe(true);
  });
});

suite('derived state is memoised, and invalidated exactly', () => {
  it('serves repeated reads without replaying the log again', async () => {
    let replays = 0;
    const log = new MemoryEventLog();
    const counting = {
      append: (events: readonly CaptureEvent[]) => log.append(events),
      replay: (docId: string) => {
        replays += 1;
        return log.replay(docId);
      },
      docIds: () => log.docIds(),
      since: (seq: number) => log.since(seq),
      count: () => log.count(),
    };
    const store = new DocumentStore(counting);
    await store.commit(...base(DOC_A));

    await store.states();
    await store.states();
    await store.states();
    expect(replays).toBe(1);
  });

  it('notices its own writes', async () => {
    const store = new DocumentStore(new MemoryEventLog());
    await store.commit(...base(DOC_A));
    expect((await store.state(DOC_A))!.status).toBe('QUEUED');

    await store.commit({ type: 'UploadStarted', docId: DOC_A, at: 2_000, attempt: 1 });
    // A stale memo here would hide the transition entirely.
    expect((await store.state(DOC_A))!.status).toBe('UPLOADING');

    await store.commit({ type: 'TaskAccepted', docId: DOC_A, at: 2_100, taskId: 't' });
    expect((await store.state(DOC_A))!.taskId).toBe('t');
  });

  it('picks up a document it had never seen', async () => {
    const store = new DocumentStore(new MemoryEventLog());
    await store.commit(...base(DOC_A));
    expect((await store.states()).size).toBe(1);
    await store.commit(...base(DOC_B));
    expect((await store.states()).size).toBe(2);
  });

  it('can be told to forget everything', async () => {
    const store = new DocumentStore(new MemoryEventLog());
    await store.commit(...base(DOC_A));
    await store.states();
    store.invalidate();
    // Same answer, just recomputed — the memo changes speed, never results.
    expect((await store.state(DOC_A))!.status).toBe('QUEUED');
  });

  it('stays flat as the library grows, rather than quadratic', async () => {
    const store = new DocumentStore(new MemoryEventLog());
    for (let i = 0; i < 600; i++) {
      const id = String(i).padStart(64, '0');
      await store.commit(
        { type: 'Captured', docId: id, at: 1, pages: [page('p1')], sha256: id, bytes: 1 },
        { type: 'Enqueued', docId: id, at: 1, sha256: id },
      );
    }
    await store.states(); // warm

    const start = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) await store.states();
    const perPass = Number(process.hrtime.bigint() - start) / 1e6 / 20;
    // Before the memo, one pass over 600 documents cost tens of milliseconds.
    expect(perPass, `${perPass.toFixed(2)} ms per pass`).toBeLessThan(5);
  });
});
