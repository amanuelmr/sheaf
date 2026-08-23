export type {
  CaptureEvent,
  CaptureEventType,
  DocId,
  FailureReason,
  MetadataPatch,
  PageId,
  PageRef,
  ServerOutcome,
  Suggestions,
} from './events';
export type { DocState, DocStatus } from './state';
export { isSynced, mayBeOnServer, needsUser } from './state';
export { apply, reduce } from './reduce';
export type { Command, NetStatus, SyncPolicy, Tick } from './machine';
export { next, shouldAutoRetryOnReconnect } from './machine';
export { MAX_AUTO_ATTEMPTS, backoffMs, taskPollDelayMs } from './backoff';
export type { UserAction, UserFacingError } from './errors';
export { describe, isBlocking, isRetryable } from './errors';
