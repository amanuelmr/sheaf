import { isRetryable } from './errors';
import type { DocId, MetadataPatch } from './events';
import type { DocState } from './state';

export type NetStatus = 'offline' | 'cellular' | 'wifi';

export interface SyncPolicy {
  readonly wifiOnly: boolean;
  /** Conservative default: keep the local copy even after a confirmed sync. */
  readonly keepLocalAfterSync: boolean;
}

export interface Tick {
  /** Supplied by the caller. The core never reads a clock. */
  readonly now: number;
  readonly net: NetStatus;
  readonly policy: SyncPolicy;
  /**
   * True on the first tick after process start. An UPLOADING document seen while
   * resuming means we died mid-request: we must ask the server what happened
   * rather than blindly uploading again.
   */
  readonly resuming: boolean;
}

export type Command =
  | { readonly type: 'upload'; readonly docId: DocId }
  | { readonly type: 'pollTask'; readonly docId: DocId; readonly taskId: string }
  /** Establish ground truth for a document whose fate we do not know. */
  | { readonly type: 'reconcile'; readonly docId: DocId; readonly sha256: string }
  | { readonly type: 'fetchSuggestions'; readonly docId: DocId; readonly remoteId: number }
  | {
      readonly type: 'patchMetadata';
      readonly docId: DocId;
      readonly remoteId: number;
      readonly patch: MetadataPatch;
    }
  | { readonly type: 'releaseLocalFiles'; readonly docId: DocId }
  | { readonly type: 'wait'; readonly docId: DocId; readonly untilMs: number | null }
  | { readonly type: 'idle'; readonly docId: DocId };

function canReachServer(tick: Tick): boolean {
  if (tick.net === 'offline') return false;
  return !tick.policy.wifiOnly || tick.net === 'wifi';
}

/**
 * Decide the single next thing to do for one document. Pure: same state plus same
 * tick always yields the same command, which is what lets the simulator explore
 * thousands of fault schedules deterministically.
 */
export function next(state: DocState, tick: Tick): Command {
  const { docId } = state;

  // Crash mid-request. The bytes may or may not have landed; ask, don't guess.
  if (tick.resuming && state.status === 'UPLOADING') {
    return { type: 'reconcile', docId, sha256: state.sha256 };
  }

  switch (state.status) {
    case 'DRAFT':
      return { type: 'idle', docId };

    case 'QUEUED':
      return canReachServer(tick)
        ? { type: 'upload', docId }
        : { type: 'wait', docId, untilMs: null };

    case 'BACKOFF': {
      if (state.nextAttemptAt !== null && tick.now < state.nextAttemptAt) {
        return { type: 'wait', docId, untilMs: state.nextAttemptAt };
      }
      return canReachServer(tick)
        ? { type: 'upload', docId }
        : { type: 'wait', docId, untilMs: null };
    }

    case 'UPLOADING':
      // A request is in flight and it is not ours to duplicate.
      return { type: 'idle', docId };

    case 'AWAITING_SERVER':
      // Note: no branch here can return 'upload'. That is the exactly-once guarantee.
      if (state.taskId === null) return { type: 'reconcile', docId, sha256: state.sha256 };
      return tick.net === 'offline'
        ? { type: 'wait', docId, untilMs: null }
        : { type: 'pollTask', docId, taskId: state.taskId };

    case 'BLOCKED':
    case 'FAILED':
      // Waiting will not help. The user decides.
      return { type: 'idle', docId };

    case 'SYNCED': {
      if (state.remoteId !== null && state.metadata !== null && !state.metadataPatched) {
        return { type: 'patchMetadata', docId, remoteId: state.remoteId, patch: state.metadata };
      }
      if (state.remoteId !== null && state.suggestions === null) {
        return { type: 'fetchSuggestions', docId, remoteId: state.remoteId };
      }
      const metadataSettled = state.metadata === null || state.metadataPatched;
      if (!tick.policy.keepLocalAfterSync && state.localFilesPresent && metadataSettled) {
        return { type: 'releaseLocalFiles', docId };
      }
      return { type: 'idle', docId };
    }
  }
}

/**
 * A document that stopped only because the network was against it deserves a free
 * retry the moment connectivity returns. Documents blocked on a bad token do not.
 */
export function shouldAutoRetryOnReconnect(state: DocState): boolean {
  return state.status === 'FAILED' && state.lastError !== null && isRetryable(state.lastError);
}
