import { describe as explainFailure, type CaptureEvent } from '@sheaf/core';

/**
 * The paper trail: the document's log, rendered.
 *
 * Every capture app *asserts* that it never loses a document. Because the log is
 * the source of truth here, this screen can show the receipts instead — and it
 * costs one query, because the history already exists.
 */
export interface TrailEntry {
  readonly at: number;
  readonly text: string;
  /** True for entries a user should be able to spot without reading. */
  readonly notable: boolean;
}

const shortTask = (taskId: string): string =>
  taskId.length <= 10 ? taskId : `${taskId.slice(0, 8)}…`;

export function paperTrail(events: readonly CaptureEvent[]): readonly TrailEntry[] {
  return events.map((event) => ({ at: event.at, ...describeEvent(event) }));
}

function describeOutcome(outcome: Extract<CaptureEvent, { type: 'ServerConfirmed' }>['outcome']): {
  text: string;
  notable: boolean;
} {
  switch (outcome.kind) {
    case 'stored':
      return { text: `Paperless confirmed — document #${outcome.remoteId}`, notable: true };
    case 'duplicate':
      return {
        text:
          outcome.remoteId === null
            ? 'Paperless already had this document'
            : `Paperless already had this document (#${outcome.remoteId})`,
        notable: true,
      };
    case 'consumer_failed':
      return { text: `Paperless declined it — ${outcome.message}`, notable: true };
  }
}

function describeEvent(event: CaptureEvent): { text: string; notable: boolean } {
  switch (event.type) {
    case 'Captured': {
      const n = event.pages.length;
      return { text: `Captured (${n} ${n === 1 ? 'page' : 'pages'})`, notable: true };
    }
    case 'PageAdded':
      return { text: 'Page added', notable: false };
    case 'PageReplaced':
      return { text: 'Page edited', notable: false };
    case 'PageRemoved':
      return { text: 'Page removed', notable: false };
    case 'Enqueued':
      return { text: 'Queued for Paperless', notable: false };
    case 'UploadStarted':
      return { text: `Upload attempt ${event.attempt}`, notable: false };
    case 'UploadFailed':
      return {
        text: `Attempt ${event.attempt} failed — ${lowerFirst(explainFailure(event.reason).title)}`,
        notable: true,
      };
    case 'TaskAccepted':
      return { text: `Accepted by Paperless (task ${shortTask(event.taskId)})`, notable: false };
    case 'ServerConfirmed':
      return describeOutcome(event.outcome);
    case 'SuggestionsReceived':
      return { text: 'Suggestions received from Paperless', notable: false };
    case 'MetadataAccepted':
      return { text: 'You accepted the suggested details', notable: false };
    case 'MetadataPatched':
      return { text: 'Details saved to Paperless', notable: false };
    case 'SideTaskFailed': {
      const why = lowerFirst(explainFailure(event.reason).title);
      return event.task === 'suggestions'
        ? { text: `Couldn't get suggestions — ${why}`, notable: false }
        : { text: `Couldn't save your details — ${why}`, notable: true };
    }
    case 'GaveUp':
      return { text: 'Stopped retrying — still saved on this device', notable: true };
    case 'RetryRequested':
      return { text: 'Retry requested', notable: false };
    case 'LocalFilesReleased':
      return { text: 'Local copy released', notable: false };
  }
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
