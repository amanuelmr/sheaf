export type {
  CaptureEvent,
  CaptureEventType,
  DocId,
  FailureReason,
  MetadataPatch,
  PageId,
  PageRef,
  RemoteId,
  ServerOutcome,
  SideTask,
  Suggestions,
} from './events.ts';
export type { DocState, DocStatus, SideTaskState } from './state.ts';
export { hasUnsavedDetails, isSynced, mayBeOnServer, needsUser } from './state.ts';
export { apply, reduce } from './reduce.ts';
export type { Command, NetStatus, SyncPolicy, Tick } from './machine.ts';
export { next, shouldAutoRetryOnReconnect } from './machine.ts';
export { MAX_AUTO_ATTEMPTS, backoffMs, taskPollDelayMs } from './backoff.ts';
export type { UserAction, UserFacingError } from './errors.ts';
export { describe, isBlocking, isRetryable } from './errors.ts';
