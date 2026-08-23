import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { DocState, NetStatus, SyncPolicy } from '@sheaf/core';
import { err, ok, type ApiResult, type PaperlessTask } from '@sheaf/paperless';
import { DocumentStore, MemoryEventLog } from '@sheaf/store';
import { SyncEngine } from '../src/engine';
import type { EnginePorts } from '../src/ports';

const DOC = 'a'.repeat(64);

interface Recording {
  calls: string[];
  postResult: ApiResult<string>;
  postThrows: Error | null;
  taskResult: ApiResult<PaperlessTask | null>;
  findResult: ApiResult<number | null>;
  suggestResult: ApiResult<{ title?: string }>;
  patchResult: ApiResult<null>;
  releaseCalls: number;
  net: NetStatus;
  policy: SyncPolicy;
  now: number;
}

function harness() {
  const log = new MemoryEventLog();
  const store = new DocumentStore(log);

  const r: Recording = {
    calls: [],
    postResult: ok('task-1'),
    postThrows: null,
    taskResult: ok({ task_id: 'task-1', status: 'PENDING' }),
    findResult: ok(null),
    suggestResult: ok({ title: 'Amazon receipt' }),
    patchResult: ok(null),
    releaseCalls: 0,
    net: 'wifi',
    policy: { wifiOnly: false, keepLocalAfterSync: true },
    now: 1_000,
  };

  const ports: EnginePorts = {
    now: () => (r.now += 1),
    jitter: () => 0.5,
    net: () => r.net,
    policy: () => r.policy,
    api: {
      postDocument: (state: DocState) => {
        r.calls.push('postDocument');
        if (r.postThrows !== null) throw r.postThrows;
        void state;
        return Promise.resolve(r.postResult);
      },
      getTask: () => {
        r.calls.push('getTask');
        return Promise.resolve(r.taskResult);
      },
      findByCaptureId: () => {
        r.calls.push('findByCaptureId');
        return Promise.resolve(r.findResult);
      },
      getSuggestions: () => {
        r.calls.push('getSuggestions');
        return Promise.resolve(r.suggestResult);
      },
      patchDocument: () => {
        r.calls.push('patchDocument');
        return Promise.resolve(r.patchResult);
      },
    },
    files: {
      release: () => {
        r.calls.push('release');
        r.releaseCalls += 1;
        return Promise.resolve();
      },
    },
  };

  return { log, store, r, engine: new SyncEngine(store, ports) };
}

const capture = (engine: SyncEngine) =>
  engine.capture({
    docId: DOC,
    sha256: DOC,
    bytes: 210_000,
    pages: [{ id: 'p1', path: '/d/p1.jpg', width: 1700, height: 2200, bytes: 210_000 }],
  });

const types = async (log: MemoryEventLog) => (await log.since(0)).map((r) => r.event.type);

suite('capture', () => {
  it('commits and queues in one go, so nothing waits on a human', async () => {
    const { engine, log, store } = harness();
    await capture(engine);
    expect(await types(log)).toEqual(['Captured', 'Enqueued']);
    expect((await store.state(DOC))!.status).toBe('QUEUED');
  });
});

suite('upload', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await capture(h.engine);
  });

  it('logs the attempt before making the request, not after', async () => {
    // The ordering is the entire crash story: an attempt whose outcome is unknown
    // must be visible in the log.
    await h.engine.tick(DOC);
    const events = await h.log.since(0);
    const startedAt = events.findIndex((e) => e.event.type === 'UploadStarted');
    expect(startedAt).toBeGreaterThan(-1);
    expect(h.r.calls).toEqual(['postDocument']);
    expect(events[startedAt + 1]!.event.type).toBe('TaskAccepted');
  });

  it('records the task id, and then never uploads again', async () => {
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.taskId).toBe('task-1');
    h.r.calls = [];
    await h.engine.tick(DOC);
    expect(h.r.calls).toEqual(['getTask']);
  });

  it('leaves the log at UploadStarted when the process dies mid-request', async () => {
    // A thrown port error is not an outcome. The engine must not invent one.
    h.r.postThrows = new Error('process killed');
    await expect(h.engine.tick(DOC)).rejects.toThrow('process killed');
    expect(await types(h.log)).toEqual(['Captured', 'Enqueued', 'UploadStarted']);
    expect((await h.store.state(DOC))!.status).toBe('UPLOADING');

    // On resume it asks the server rather than sending again.
    h.r.postThrows = null;
    h.r.calls = [];
    h.r.findResult = ok(4821);
    await h.engine.tick(DOC, true);
    expect(h.r.calls).toEqual(['findByCaptureId']);
    expect((await h.store.state(DOC))!.status).toBe('SYNCED');
  });

  it('turns an expected failure into a retry, keeping the document', async () => {
    h.r.postResult = err({ kind: 'unreachable' });
    await h.engine.tick(DOC);
    const state = (await h.store.state(DOC))!;
    expect(state.status).toBe('BACKOFF');
    expect(state.attempts).toBe(1);
    expect(state.localFilesPresent).toBe(true);
  });

  it('waits instead of uploading when there is no usable connection', async () => {
    h.r.net = 'offline';
    await h.engine.tick(DOC);
    expect(h.r.calls).toEqual([]);
    expect(await types(h.log)).toEqual(['Captured', 'Enqueued']);
  });
});

suite('confirmation', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await capture(h.engine);
    await h.engine.tick(DOC); // accepted, task-1
  });

  it('does nothing while the consumer is still working', async () => {
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.status).toBe('AWAITING_SERVER');
  });

  it('reads a duplicate rejection as success', async () => {
    h.r.taskResult = ok({
      task_id: 'task-1',
      status: 'FAILURE',
      result: 'It is a duplicate of Amazon receipt (#4821)',
    });
    await h.engine.tick(DOC);
    const state = (await h.store.state(DOC))!;
    expect(state.status).toBe('SYNCED');
    expect(state.remoteId).toBe(4821);
  });

  it('asks the server directly when it has forgotten the task', async () => {
    // A missing task is not evidence either way, so it must not be read as failure.
    h.r.taskResult = ok(null);
    h.r.findResult = ok(99);
    h.r.calls = [];
    await h.engine.tick(DOC);
    expect(h.r.calls).toEqual(['getTask', 'findByCaptureId']);
    expect((await h.store.state(DOC))!.remoteId).toBe(99);
  });

  it('folds a genuinely absent document back into the retry path', async () => {
    h.r.taskResult = ok(null);
    h.r.findResult = ok(null);
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.status).toBe('BACKOFF');
  });

  it('records nothing when it cannot tell, rather than guessing', async () => {
    h.r.taskResult = err({ kind: 'server_error', status: 503 });
    const before = await h.log.count();
    await h.engine.tick(DOC);
    expect(await h.log.count()).toBe(before);
    expect((await h.store.state(DOC))!.status).toBe('AWAITING_SERVER');
  });
});

suite('after syncing', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await capture(h.engine);
    await h.engine.tick(DOC);
    h.r.taskResult = ok({
      task_id: 'task-1',
      status: 'SUCCESS',
      related_document: 4821,
    });
    await h.engine.tick(DOC);
  });

  it('pulls suggestions from Paperless rather than guessing on device', async () => {
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.suggestions).toEqual({ title: 'Amazon receipt' });
  });

  it('sends accepted details to the document that is already stored', async () => {
    await h.engine.tick(DOC); // suggestions
    await h.engine.acceptMetadata(DOC, { title: 'Amazon receipt' });
    h.r.calls = [];
    await h.engine.tick(DOC);
    expect(h.r.calls).toEqual(['patchDocument']);
    expect((await h.store.state(DOC))!.metadataPatched).toBe(true);
  });

  it('keeps the accepted details pending when the patch fails', async () => {
    await h.engine.tick(DOC);
    await h.engine.acceptMetadata(DOC, { title: 'x' });
    h.r.patchResult = err({ kind: 'unreachable' });
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.metadataPatched).toBe(false);
  });

  it('deletes the local copy only when retention says so, and only after the file is gone', async () => {
    await h.engine.tick(DOC); // suggestions
    expect(h.r.releaseCalls).toBe(0); // default retention keeps it

    h.r.policy = { wifiOnly: false, keepLocalAfterSync: false };
    await h.engine.tick(DOC);
    expect(h.r.releaseCalls).toBe(1);
    expect((await h.store.state(DOC))!.localFilesPresent).toBe(false);
    // The event records what already happened, never what is hoped for.
    expect(h.r.calls[h.r.calls.length - 1]).toBe('release');
  });
});

suite('retrying', () => {
  it('re-arms what the network defeated and leaves a bad token alone', async () => {
    const h = harness();
    await capture(h.engine);

    // Exhaust the automatic budget with retryable failures.
    h.r.postResult = err({ kind: 'unreachable' });
    for (let i = 0; i < 5; i++) {
      h.r.now += 1_000_000; // jump past the backoff
      await h.engine.tick(DOC);
    }
    expect((await h.store.state(DOC))!.status).toBe('FAILED');
    expect(await h.engine.retryAfterReconnect()).toBe(1);
    expect((await h.store.state(DOC))!.status).toBe('QUEUED');

    // A blocked document is not the network's fault, so reconnecting changes nothing.
    h.r.postResult = err({ kind: 'auth', status: 401 });
    await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.status).toBe('BLOCKED');
    expect(await h.engine.retryAfterReconnect()).toBe(0);

    // The user fixing the token does re-arm it.
    await h.engine.requestRetry(DOC);
    expect((await h.store.state(DOC))!.status).toBe('QUEUED');
  });

  it('ticks every document it knows about', async () => {
    const h = harness();
    await capture(h.engine);
    await h.engine.capture({
      docId: 'b'.repeat(64),
      sha256: 'b'.repeat(64),
      bytes: 1,
      pages: [{ id: 'p', path: '/p', width: 1, height: 1, bytes: 1 }],
    });
    const commands = await h.engine.tickAll();
    expect(commands.map((c) => c.type)).toEqual(['upload', 'upload']);
  });

  it('ignores a document it has never heard of', async () => {
    const h = harness();
    expect(await h.engine.tick('unknown')).toBeNull();
  });
});
