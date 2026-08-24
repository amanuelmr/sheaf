import type { DocState, DocStatus, RemoteId } from '@sheaf/core';
import { describe as explainFailure, hasUnsavedDetails } from '@sheaf/core';

/**
 * What the outbox screen renders.
 *
 * The status text lives here rather than in a component, so accessibility is a
 * tested property. Colour alone never carries meaning (spec §41): every row has a
 * symbol and a sentence, and a screen reader gets the same information as an eye.
 */
export interface OutboxRow {
  readonly docId: string;
  readonly status: DocStatus;
  /** Non-colour status indicator. */
  readonly symbol: '✓' | '↻' | '⋯' | '⚠' | '•';
  readonly label: string;
  /** The reassurance or next step, when there is one. */
  readonly detail: string | null;
  readonly pageCount: number;
  readonly bytes: number;
  readonly attempts: number;
  readonly remoteId: RemoteId | null;
  readonly nextAttemptAt: number | null;
  /** True when the user can do something useful about this row. */
  readonly actionable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Rows the user should look at first come first. */
const PRIORITY: Record<DocStatus, number> = {
  BLOCKED: 0,
  FAILED: 1,
  UPLOADING: 2,
  AWAITING_SERVER: 3,
  BACKOFF: 4,
  QUEUED: 5,
  DRAFT: 6,
  SYNCED: 7,
};

export function toOutboxRow(state: DocState): OutboxRow {
  const { symbol, label, detail, actionable } = present(state);
  return {
    docId: state.docId,
    status: state.status,
    symbol,
    label,
    detail,
    pageCount: state.pages.length,
    bytes: state.bytes,
    attempts: state.attempts,
    remoteId: state.remoteId,
    nextAttemptAt: state.nextAttemptAt,
    actionable,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function projectOutbox(states: Iterable<DocState>): readonly OutboxRow[] {
  return [...states]
    .map(toOutboxRow)
    .sort(
      (a, b) =>
        PRIORITY[a.status] - PRIORITY[b.status] ||
        b.updatedAt - a.updatedAt ||
        a.docId.localeCompare(b.docId),
    );
}

/** How many documents are still on their way. Drives the count under the shutter. */
export function pendingCount(rows: readonly OutboxRow[]): number {
  return rows.filter((row) => row.status !== 'SYNCED').length;
}

function present(state: DocState): {
  symbol: OutboxRow['symbol'];
  label: string;
  detail: string | null;
  actionable: boolean;
} {
  switch (state.status) {
    case 'DRAFT':
      return { symbol: '•', label: 'Not finished', detail: null, actionable: true };
    case 'QUEUED':
      return {
        symbol: '↻',
        label: 'Waiting for your server',
        detail: 'Saved safely on this device.',
        actionable: false,
      };
    case 'UPLOADING':
      return { symbol: '⋯', label: 'Sending', detail: null, actionable: false };
    case 'AWAITING_SERVER':
      return {
        symbol: '⋯',
        label: 'Checking with Paperless',
        detail: 'Paperless has it and is filing it now.',
        actionable: false,
      };
    case 'BACKOFF':
      return {
        symbol: '↻',
        label: 'Waiting to try again',
        detail: state.lastError === null ? null : explainFailure(state.lastError).title,
        actionable: false,
      };
    case 'SYNCED':
      // The document itself is safe; only the details the user chose did not stick.
      // That is worth surfacing, and it is the one case where SYNCED is actionable.
      if (hasUnsavedDetails(state)) {
        return {
          symbol: '⚠',
          label: 'Synced — details not saved',
          detail: 'The document is in Paperless. Only the details you chose didn’t save.',
          actionable: true,
        };
      }
      return { symbol: '✓', label: 'Synced', detail: null, actionable: false };
    case 'BLOCKED': {
      const error = state.lastError === null ? null : explainFailure(state.lastError);
      return {
        symbol: '⚠',
        label: error?.title ?? 'Needs your attention',
        detail: error?.reassurance ?? 'Saved safely on this device.',
        actionable: true,
      };
    }
    case 'FAILED': {
      const error = state.lastError === null ? null : explainFailure(state.lastError);
      return {
        symbol: '⚠',
        label: 'Sync failed',
        detail: error?.reassurance ?? 'Your document is safe on this device.',
        actionable: true,
      };
    }
  }
}
