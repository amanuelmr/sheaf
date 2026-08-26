import type { CaptureEvent } from '@sheaf/core';

export const DOC_A = 'a'.repeat(64);
export const DOC_B = 'b'.repeat(64);

export const page = (id: string) => ({
  id,
  path: `/docs/${id}.jpg`,
  width: 1700,
  height: 2200,
  bytes: 210_000,
});

/** One of every event type, so serialisation fidelity is covered end to end. */
export function fullLife(docId = DOC_A): CaptureEvent[] {
  return [
    {
      type: 'Captured',
      docId,
      at: 1_000,
      pages: [page('p1'), page('p2')],
      sha256: docId,
      bytes: 420_000,
    },
    { type: 'PageAdded', docId, at: 1_100, page: page('p3') },
    { type: 'PageReplaced', docId, at: 1_150, page: page('p3') },
    { type: 'PageRemoved', docId, at: 1_200, pageId: 'p3' },
    { type: 'Enqueued', docId, at: 1_300, sha256: docId },
    { type: 'UploadStarted', docId, at: 2_000, attempt: 1 },
    {
      type: 'UploadFailed',
      docId,
      at: 2_100,
      attempt: 1,
      reason: { kind: 'unreachable' },
      jitter: 0.25,
    },
    { type: 'UploadStarted', docId, at: 5_000, attempt: 2 },
    { type: 'TaskAccepted', docId, at: 5_100, taskId: 'a3f9c1d2-4b5e-6789-abcd-ef0123456789' },
    {
      type: 'ServerConfirmed',
      docId,
      at: 5_900,
      outcome: { kind: 'stored', remoteId: 4821 },
    },
    {
      type: 'SuggestionsReceived',
      docId,
      at: 6_000,
      suggestions: { correspondent: 'Amazon', tags: ['shopping'] },
    },
    {
      type: 'MetadataAccepted',
      docId,
      at: 6_100,
      patch: { title: 'Amazon receipt', tags: ['shopping'] },
    },
    { type: 'MetadataPatched', docId, at: 6_200 },
    { type: 'LocalFilesReleased', docId, at: 6_300 },
  ];
}
