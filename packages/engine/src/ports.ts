import type {
  DocState,
  MetadataPatch,
  NetStatus,
  RemoteId,
  ServerOutcome,
  Suggestions,
  SyncPolicy,
} from '@sheaf/core';
import type { ApiResult } from '@sheaf/http';

/**
 * Everything impure, named and injected.
 *
 * The contract that matters: **ports return a result for failures they expect, and
 * throw only for what nobody can handle.** The engine does not wrap port calls in
 * try/catch, so a thrown error propagates and the tick is abandoned mid-way — which
 * is exactly what a process death looks like, and exactly what the log is designed
 * to survive. Swallowing it would turn a clean crash into an invented outcome.
 */
/**
 * What an upload was answered with.
 *
 * A server that consumes asynchronously hands back a task to poll. A server whose
 * PUT is authoritative -- because the document lives at the address of its own
 * content -- can answer immediately, and making it invent a task id just to be
 * polled once would be a round trip spent on ceremony.
 */
export type UploadAccepted =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'confirmed'; readonly outcome: ServerOutcome };

export interface EngineApi {
  /** The document's bytes are found from its hash; storage is content-addressed. */
  postDocument(state: DocState): Promise<ApiResult<UploadAccepted>>;
  /**
   * Poll a task, for servers that consume asynchronously.
   *
   * Optional: a server whose upload is authoritative never hands back a task, and
   * requiring it to implement polling would be modelling somebody else's design.
   * Interpreting the server's own task format is the adapter's job -- the engine
   * only needs the outcome. `'pending'` means still working; `null` means the
   * server has forgotten the task, which is not evidence either way.
   */
  pollTask?(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>>;
  /** Ground truth after losing track of an upload. Must never false-positive. */
  findByCaptureId(sha256: string): Promise<ApiResult<RemoteId | null>>;
  /** Ids already resolved to names by the adapter, using its cached vocabulary. */
  getSuggestions(remoteId: RemoteId): Promise<ApiResult<Suggestions>>;
  patchDocument(remoteId: RemoteId, patch: MetadataPatch): Promise<ApiResult<null>>;
}

export interface EngineFiles {
  /** Delete the local originals. Only ever called for a confirmed document. */
  release(state: DocState): Promise<void>;
}

export interface EnginePorts {
  now(): number;
  /** In [0, 1). Real randomness on device, a seeded stream in the simulator. */
  jitter(): number;
  net(): NetStatus;
  policy(): SyncPolicy;
  readonly api: EngineApi;
  readonly files: EngineFiles;
}
