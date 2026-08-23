import type { DocState, MetadataPatch, NetStatus, Suggestions, SyncPolicy } from '@sheaf/core';
import type { ApiResult, PaperlessTask } from '@sheaf/paperless';

/**
 * Everything impure, named and injected.
 *
 * The contract that matters: **ports return a result for failures they expect, and
 * throw only for what nobody can handle.** The engine does not wrap port calls in
 * try/catch, so a thrown error propagates and the tick is abandoned mid-way — which
 * is exactly what a process death looks like, and exactly what the log is designed
 * to survive. Swallowing it would turn a clean crash into an invented outcome.
 */
export interface EngineApi {
  /** The document's bytes are found from its hash; storage is content-addressed. */
  postDocument(state: DocState): Promise<ApiResult<string>>;
  getTask(taskId: string): Promise<ApiResult<PaperlessTask | null>>;
  /** Ground truth after losing track of an upload. Must never false-positive. */
  findByCaptureId(sha256: string): Promise<ApiResult<number | null>>;
  /** Ids already resolved to names by the adapter, using its cached vocabulary. */
  getSuggestions(remoteId: number): Promise<ApiResult<Suggestions>>;
  patchDocument(remoteId: number, patch: MetadataPatch): Promise<ApiResult<null>>;
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
