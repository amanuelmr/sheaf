import { describe as explainFailure, type CaptureEvent, type RemoteId } from '@sheaf/core';

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

/**
 * How the server names the document, in a form a person can read. A serial number
 * stays as it is; a content hash is far too long to show whole.
 */
const shortRemote = (id: RemoteId): string =>
  typeof id === 'number' ? `#${id}` : `${id.slice(0, 8)}…`;

export function paperTrail(events: readonly CaptureEvent[]): readonly TrailEntry[] {
  return events.map((event) => ({ at: event.at, ...describeEvent(event) }));
}

function describeOutcome(outcome: Extract<CaptureEvent, { type: 'ServerConfirmed' }>['outcome']): {
  text: string;
  notable: boolean;
} {
  switch (outcome.kind) {
    case 'stored':
      return {
        text:
          outcome.remoteId === null
            ? 'Your server confirmed it'
            : `Your server confirmed it — ${shortRemote(outcome.remoteId)}`,
        notable: true,
      };
    case 'duplicate':
      return {
        text:
          outcome.remoteId === null
            ? 'Your server already had this document'
            : `Your server already had this document (${shortRemote(outcome.remoteId)})`,
        notable: true,
      };
    case 'consumer_failed':
      return { text: `Your server declined it — ${outcome.message}`, notable: true };
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
      return { text: 'Queued to send', notable: false };
    case 'UploadStarted':
      return { text: `Upload attempt ${event.attempt}`, notable: false };
    case 'UploadFailed':
      return {
        text: `Attempt ${event.attempt} failed — ${lowerFirst(explainFailure(event.reason).title)}`,
        notable: true,
      };
    case 'TaskAccepted':
      return { text: `Accepted by your server (task ${shortTask(event.taskId)})`, notable: false };
    case 'ServerConfirmed':
      return describeOutcome(event.outcome);
    case 'SuggestionsReceived':
      return { text: 'Suggestions received', notable: false };
    case 'MetadataAccepted':
      return { text: 'You accepted the suggested details', notable: false };
    case 'MetadataPatched':
      return { text: 'Details saved to your server', notable: false };
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
