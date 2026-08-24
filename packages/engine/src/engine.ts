import {
  next,
  shouldAutoRetryOnReconnect,
  type CaptureEvent,
  type Command,
  type DocId,
  type DocState,
  type FailureReason,
  type MetadataPatch,
  type PageRef,
  type RemoteId,
  type SideTask,
} from '@sheaf/core';
import type { DocumentStore } from '@sheaf/store';
import type { EnginePorts } from './ports';

/**
 * What happened when the shutter fired.
 *
 * Because identity is the content hash, scanning the same piece of paper twice
 * produces the same document — so this is also the spec's duplicate detection (§26),
 * for free. The UI needs to know, or it reports a success that did not happen.
 */
export type CaptureOutcome =
  { readonly kind: 'captured' } | { readonly kind: 'already-captured'; readonly state: DocState };

export interface CaptureInput {
  readonly docId: DocId;
  readonly sha256: string;
  readonly bytes: number;
  readonly pages: readonly PageRef[];
}

/**
 * The impure half of the loop.
 *
 * `next()` decides; this performs. Every effect ends in an appended event, and the
 * next decision is made by replaying the log — so there is no in-memory state that
 * a crash could take with it.
 */
export class SyncEngine {
  constructor(
    private readonly store: DocumentStore,
    private readonly ports: EnginePorts,
  ) {}

  /**
   * The shutter. Commits the capture and immediately makes it eligible for upload:
   * the document is durable and on its way before any human looks at it.
   */
  async capture(input: CaptureInput): Promise<CaptureOutcome> {
    // Identical content is the same document. Appending a second Captured event
    // would be inert -- the reducer ignores it -- but it would pad the log and let
    // the UI claim a success that never happened.
    const existing = await this.store.state(input.docId);
    if (existing !== null) return { kind: 'already-captured', state: existing };

    const at = this.ports.now();
    await this.store.commit(
      {
        type: 'Captured',
        docId: input.docId,
        at,
        pages: input.pages,
        sha256: input.sha256,
        bytes: input.bytes,
      },
      { type: 'Enqueued', docId: input.docId, at, sha256: input.sha256 },
    );
    return { kind: 'captured' };
  }

  /** Advance one document by exactly one command. */
  async tick(docId: DocId, resuming = false): Promise<Command | null> {
    const state = await this.store.state(docId);
    if (state === null) return null;

    const command = next(state, {
      now: this.ports.now(),
      net: this.ports.net(),
      policy: this.ports.policy(),
      resuming,
    });

    await this.perform(command, state);
    return command;
  }

  async tickAll(resuming = false): Promise<readonly Command[]> {
    const commands: Command[] = [];
    for (const docId of (await this.store.states()).keys()) {
      const command = await this.tick(docId, resuming);
      if (command !== null) commands.push(command);
    }
    return commands;
  }

  /** The user tapped Retry, or connectivity came back. */
  async requestRetry(docId: DocId): Promise<void> {
    await this.store.commit({ type: 'RetryRequested', docId, at: this.ports.now() });
  }

  /**
   * Re-arm documents the network defeated. Documents blocked on a bad token are
   * left alone: connectivity was never their problem.
   */
  async retryAfterReconnect(): Promise<number> {
    let rearmed = 0;
    for (const [docId, state] of await this.store.states()) {
      if (shouldAutoRetryOnReconnect(state)) {
        await this.requestRetry(docId);
        rearmed += 1;
      }
    }
    return rearmed;
  }

  async acceptMetadata(docId: DocId, patch: MetadataPatch): Promise<void> {
    await this.store.commit({ type: 'MetadataAccepted', docId, at: this.ports.now(), patch });
  }

  private async perform(command: Command, state: DocState): Promise<void> {
    switch (command.type) {
      case 'upload':
        return this.upload(state);
      case 'pollTask':
        return this.poll(state, command.taskId);
      case 'reconcile':
        return this.reconcile(state);
      case 'fetchSuggestions':
        return this.fetchSuggestions(state, command.remoteId);
      case 'patchMetadata':
        return this.patchMetadata(state, command.remoteId, command.patch);
      case 'releaseLocalFiles':
        return this.releaseFiles(state);
      case 'wait':
      case 'idle':
        return;
    }
  }

  private async upload(state: DocState): Promise<void> {
    const attempt = state.attempts + 1;
    // Logged BEFORE the request. If the process dies now, the log says an attempt
    // was in flight and its outcome is unknown -- which is what triggers
    // reconciliation instead of a blind re-upload.
    await this.store.commit({
      type: 'UploadStarted',
      docId: state.docId,
      at: this.ports.now(),
      attempt,
    });

    const result = await this.ports.api.postDocument(state);
    if (!result.ok) {
      await this.fail(state, attempt, result.reason);
      return;
    }

    // Either answer is legitimate. A task means "accepted, ask again later"; a
    // confirmation means the server already knows the outcome and there is nothing
    // to wait for.
    await this.store.commit(
      result.value.kind === 'task'
        ? {
            type: 'TaskAccepted',
            docId: state.docId,
            at: this.ports.now(),
            taskId: result.value.taskId,
          }
        : {
            type: 'ServerConfirmed',
            docId: state.docId,
            at: this.ports.now(),
            outcome: result.value.outcome,
          },
    );
  }

  private async poll(state: DocState, taskId: string): Promise<void> {
    // A server that never issues tasks has nothing to poll; asking it directly is
    // both cheaper and the only thing that could work.
    if (this.ports.api.pollTask === undefined) return this.reconcile(state);

    const result = await this.ports.api.pollTask(taskId);
    if (!result.ok) return; // transient; the next tick tries again

    // A forgotten task is not evidence either way, so establish ground truth
    // rather than assume.
    if (result.value === null) return this.reconcile(state);
    if (result.value === 'pending') return;

    await this.store.commit({
      type: 'ServerConfirmed',
      docId: state.docId,
      at: this.ports.now(),
      outcome: result.value,
    });
  }

  private async reconcile(state: DocState): Promise<void> {
    const found = await this.ports.api.findByCaptureId(state.sha256);
    if (!found.ok) return; // cannot tell; try again rather than guess

    if (found.value !== null) {
      await this.store.commit({
        type: 'ServerConfirmed',
        docId: state.docId,
        at: this.ports.now(),
        outcome: { kind: 'stored', remoteId: found.value },
      });
      return;
    }

    // Not there. Fold it back into the retry path; a redundant upload is refused
    // as a duplicate, which costs bandwidth and nothing else.
    await this.fail(state, Math.max(1, state.attempts), { kind: 'unreachable' });
  }

  private async fetchSuggestions(state: DocState, remoteId: RemoteId): Promise<void> {
    const result = await this.ports.api.getSuggestions(remoteId);
    if (!result.ok) return this.sideTaskFailed(state, 'suggestions', result.reason);
    await this.store.commit({
      type: 'SuggestionsReceived',
      docId: state.docId,
      at: this.ports.now(),
      suggestions: result.value,
    });
  }

  private async patchMetadata(
    state: DocState,
    remoteId: RemoteId,
    patch: MetadataPatch,
  ): Promise<void> {
    const result = await this.ports.api.patchDocument(remoteId, patch);
    if (!result.ok) return this.sideTaskFailed(state, 'metadata', result.reason);
    await this.store.commit({
      type: 'MetadataPatched',
      docId: state.docId,
      at: this.ports.now(),
    });
  }

  private async releaseFiles(state: DocState): Promise<void> {
    await this.ports.files.release(state);
    await this.store.commit({
      type: 'LocalFilesReleased',
      docId: state.docId,
      at: this.ports.now(),
    });
  }

  /**
   * Record a failed piece of post-sync work so the reducer can back it off and,
   * eventually, stop. Without this the engine re-asks on every tick for ever.
   */
  private async sideTaskFailed(
    state: DocState,
    task: SideTask,
    reason: FailureReason,
  ): Promise<void> {
    await this.store.commit({
      type: 'SideTaskFailed',
      docId: state.docId,
      at: this.ports.now(),
      task,
      attempt: state.side[task].attempts + 1,
      reason,
      jitter: this.ports.jitter(),
    });
  }

  private async fail(state: DocState, attempt: number, reason: FailureReason): Promise<void> {
    const event: CaptureEvent = {
      type: 'UploadFailed',
      docId: state.docId,
      at: this.ports.now(),
      attempt,
      reason,
      jitter: this.ports.jitter(),
    };
    await this.store.commit(event);
  }
}
