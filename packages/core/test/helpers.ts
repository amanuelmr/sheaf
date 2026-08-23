import type { CaptureEvent, PageRef } from '../src/events';

export const DOC = 'a'.repeat(64);

export const page = (id: string): PageRef => ({
  id,
  path: `/docs/${id}.jpg`,
  width: 1700,
  height: 2200,
  bytes: 240_000,
});

export const captured = (at = 1_000): CaptureEvent => ({
  type: 'Captured',
  docId: DOC,
  at,
  pages: [page('p1')],
  sha256: DOC,
  bytes: 240_000,
});

export const enqueued = (at = 1_001): CaptureEvent => ({
  type: 'Enqueued',
  docId: DOC,
  at,
  sha256: DOC,
});

export const started = (attempt: number, at: number): CaptureEvent => ({
  type: 'UploadStarted',
  docId: DOC,
  at,
  attempt,
});

export const failed = (
  attempt: number,
  at: number,
  reason: Extract<CaptureEvent, { type: 'UploadFailed' }>['reason'] = { kind: 'unreachable' },
  jitter = 0,
): CaptureEvent => ({ type: 'UploadFailed', docId: DOC, at, attempt, reason, jitter });

export const accepted = (taskId: string, at: number): CaptureEvent => ({
  type: 'TaskAccepted',
  docId: DOC,
  at,
  taskId,
});

export const confirmed = (
  outcome: Extract<CaptureEvent, { type: 'ServerConfirmed' }>['outcome'],
  at: number,
): CaptureEvent => ({ type: 'ServerConfirmed', docId: DOC, at, outcome });

export const ONLINE = {
  now: 10_000,
  net: 'wifi',
  policy: { wifiOnly: false, keepLocalAfterSync: true },
  resuming: false,
} as const;

export const OFFLINE = { ...ONLINE, net: 'offline' } as const;
