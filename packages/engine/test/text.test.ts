import { describe as suite, expect, it } from 'vitest';
import type { DocState } from '@sheaf/core';
import { err, ok, type ApiResult } from '@sheaf/http';
import { DocumentStore, MemoryEventLog } from '@sheaf/store';
import { SyncEngine } from '../src/engine';
import type { EngineApi, EnginePorts } from '../src/ports';

const DOC = 'd'.repeat(64);

/** Our own server: a PUT is authoritative, so the document is synced at once. */
function harness(options: { putText?: boolean; text?: string | null } = {}) {
  const store = new DocumentStore(new MemoryEventLog());
  const sent: { sha256: string; text: string }[] = [];
  let putTextResult: ApiResult<null> = ok(null);
  let now = 1_000;

  const api: EngineApi = {
    postDocument: () =>
      Promise.resolve(ok({ kind: 'confirmed', outcome: { kind: 'stored', remoteId: DOC } })),
    findByCaptureId: () => Promise.resolve(ok(null)),
    getSuggestions: () => Promise.resolve(err({ kind: 'unreachable' })),
    patchDocument: () => Promise.resolve(ok(null)),
    ...(options.putText === false
      ? {}
      : {
          putText: (state: DocState, text: string) => {
            sent.push({ sha256: state.sha256, text });
            return Promise.resolve(putTextResult);
          },
        }),
  };
  const ports: EnginePorts = {
    now: () => (now += 1),
    jitter: () => 0.5,
    net: () => 'wifi',
    policy: () => ({ wifiOnly: false, keepLocalAfterSync: true }),
    api,
    files: { release: () => Promise.resolve() },
    text: {
      read: () => Promise.resolve(options.text === undefined ? 'TOTAL 12.50' : options.text),
    },
  };
  const engine = new SyncEngine(store, ports);
  return {
    engine,
    store,
    sent,
    failNextWith: (result: ApiResult<null>) => {
      putTextResult = result;
    },
    capture: () =>
      engine.capture({
        docId: DOC,
        sha256: DOC,
        bytes: 1,
        pages: [{ id: 'p1', path: '/p1.jpg', width: 1, height: 1, bytes: 1 }],
        ocrPending: true,
      }),
  };
}

suite('sending recognised text', () => {
  it('records that OCR is under way at capture', async () => {
    const h = harness();
    await h.capture();
    expect((await h.store.state(DOC))!.text).toBe('pending');
  });

  it('sends the text once the document is on the server, exactly once', async () => {
    const h = harness();
    await h.capture();
    await h.engine.recordText(DOC, true);
    for (let i = 0; i < 5; i++) await h.engine.tick(DOC);

    expect(h.sent).toEqual([{ sha256: DOC, text: 'TOTAL 12.50' }]);
    expect((await h.store.state(DOC))!.text).toBe('uploaded');
  });

  it('records when OCR found nothing, and then sends nothing', async () => {
    const h = harness();
    await h.capture();
    await h.engine.recordText(DOC, false);
    for (let i = 0; i < 3; i++) await h.engine.tick(DOC);
    expect(h.sent).toEqual([]);
    expect((await h.store.state(DOC))!.text).toBe('none');
  });

  it('marks the text unavailable if it has vanished from the device', async () => {
    const h = harness({ text: null });
    await h.capture();
    await h.engine.recordText(DOC, true);
    for (let i = 0; i < 3; i++) await h.engine.tick(DOC);
    expect(h.sent).toEqual([]);
    expect((await h.store.state(DOC))!.text).toBe('none');
  });

  it('backs off a failed send instead of retrying on the next tick', async () => {
    const h = harness();
    await h.capture();
    await h.engine.recordText(DOC, true);
    h.failNextWith(err({ kind: 'server_error', status: 503 }));
    for (let i = 0; i < 5; i++) await h.engine.tick(DOC);

    expect(h.sent).toHaveLength(1);
    expect((await h.store.state(DOC))!.side.text.attempts).toBe(1);
  });

  it('stops asking a server that has no text route', async () => {
    const h = harness({ putText: false });
    await h.capture();
    await h.engine.recordText(DOC, true);
    for (let i = 0; i < 3; i++) await h.engine.tick(DOC);
    expect((await h.store.state(DOC))!.side.text.abandoned).toEqual({ kind: 'not_found' });
  });
});
