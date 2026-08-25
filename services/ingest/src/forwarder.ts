import { MAX_AUTO_ATTEMPTS, backoffMs, isRetryable } from '@sheaf/core';
import type { FailureReason, ServerOutcome } from '@sheaf/core';
import type { ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import type { Storage } from './storage.ts';

/**
 * Where a stored document is handed on to, so it becomes something you can search
 * rather than a file you have to remember the name of.
 *
 * Narrow on purpose: the forwarder knows about "send these bytes" and "did it
 * arrive", and nothing about whoever is on the other end. Interpreting a
 * particular server's task format belongs in the adapter, the same split the
 * engine uses on the phone.
 */
export interface ForwardTarget {
  /** Hand over the bytes. Returns a task id when the target consumes asynchronously. */
  send(document: DocumentRecord, bytes: Uint8Array): Promise<ApiResult<string>>;
  /** `'pending'` = still working. `null` = the target has forgotten the task. */
  poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>>;
  /**
   * Ask what the target calls a document it holds.
   *
   * Optional, and needed because some targets confirm an upload without naming the
   * result. A real Paperless-ngx does exactly that: status success, document id
   * null. The id is worth having, but not worth inventing.
   */
  locate?(sha256: string): Promise<ApiResult<string | null>>;
}

export interface ForwarderPorts {
  now(): number;
  /** In [0, 1). Keeps a backlog from retrying in lockstep. */
  jitter(): number;
}

export interface ForwarderResult {
  readonly examined: number;
  readonly sent: number;
  readonly completed: number;
  readonly failed: number;
}

/**
 * Moves stored documents onward, in the background, forever if need be.
 *
 * This is the same retry problem the phone has, and deliberately the same ladder --
 * but it is a much easier version of it, which is the entire reason for doing it
 * here. A phone is on a flaky network, sleeps, and gets killed; a server sits on
 * mains power next to the thing it is talking to. Moving the hand-off here means a
 * capture is safe after one short upload, rather than after a conversation with a
 * server that might be down.
 *
 * Nothing here can lose a document. Forwarding state is metadata; the bytes were
 * durable before any of this ran, and a document that can never be forwarded is
 * still a document we hold.
 */
export class Forwarder {
  readonly #storage: Storage;
  readonly #target: ForwardTarget;
  readonly #ports: ForwarderPorts;

  constructor(storage: Storage, target: ForwardTarget, ports: ForwarderPorts) {
    this.#storage = storage;
    this.#target = target;
    this.#ports = ports;
  }

  /** One pass over everything currently due. */
  async tick(): Promise<ForwarderResult> {
    const now = this.#ports.now();
    const due = await this.#storage.dueForForwarding(now);
    const result = { examined: due.length, sent: 0, completed: 0, failed: 0 };

    for (const document of due) {
      const outcome =
        document.forward.state === 'sent'
          ? await this.#awaitOutcome(document)
          : await this.#send(document);

      if (outcome === 'sent') result.sent += 1;
      if (outcome === 'completed') result.completed += 1;
      if (outcome === 'failed') result.failed += 1;
    }
    return result;
  }

  async #send(document: DocumentRecord): Promise<'sent' | 'completed' | 'failed' | 'waiting'> {
    // Ask before sending. The original design leaned on the target refusing content
    // it already held -- and a real Paperless-ngx does not: re-sending the same
    // bytes produced a second document. Since we can ask by content hash, ask.
    // One cheap request beats trusting somebody else's deduplication.
    const already = await this.#locate(document.sha256);
    if (already !== null) {
      await this.#storage.recordForwardAttempt(document.sha256, {
        state: 'done',
        attempts: document.forward.attempts,
        nextAt: null,
        remoteId: already,
        error: null,
      });
      return 'completed';
    }

    const bytes = this.#storage.bytes(document.sha256);
    if (bytes === null) {
      // The object is gone from disk. Retrying cannot conjure it back, so stop
      // rather than loop on it forever.
      await this.#give_up(document, 'the stored bytes are missing');
      return 'failed';
    }

    const sent = await this.#target.send(document, bytes);
    if (!sent.ok) return this.#backOff(document, sent.reason);

    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'sent',
      attempts: document.forward.attempts + 1,
      nextAt: null,
      taskId: sent.value,
      error: null,
    });
    return 'sent';
  }

  async #awaitOutcome(document: DocumentRecord): Promise<'completed' | 'failed' | 'waiting'> {
    const taskId = await this.#taskIdFor(document);
    // Without a task id there is nothing to ask about; start again, which is free
    // because the target refuses content it already holds.
    if (taskId === null) return this.#restart(document);

    const polled = await this.#target.poll(taskId);
    if (!polled.ok) return await this.#backOff(document, polled.reason);
    if (polled.value === null) return this.#restart(document);
    if (polled.value === 'pending') return 'waiting';

    switch (polled.value.kind) {
      case 'stored':
      case 'duplicate': {
        // A duplicate is a success: the target already holds these exact bytes.
        // Either way the hand-off is complete; only the name may still be unknown.
        const named =
          polled.value.remoteId === null
            ? await this.#locate(document.sha256)
            : String(polled.value.remoteId);
        await this.#storage.recordForwardAttempt(document.sha256, {
          state: 'done',
          attempts: document.forward.attempts,
          nextAt: null,
          remoteId: named,
          error: null,
        });
        return 'completed';
      }
      case 'consumer_failed':
        await this.#give_up(document, polled.value.message);
        return 'failed';
    }
  }

  /** Best effort. A document that arrived but cannot be named is still done. */
  async #locate(sha256: string): Promise<string | null> {
    if (this.#target.locate === undefined) return null;
    const found = await this.#target.locate(sha256);
    return found.ok ? found.value : null;
  }

  async #restart(document: DocumentRecord): Promise<'waiting'> {
    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'pending',
      attempts: document.forward.attempts,
      nextAt: null,
      error: null,
    });
    return 'waiting';
  }

  async #backOff(document: DocumentRecord, reason: FailureReason): Promise<'failed' | 'waiting'> {
    const attempts = document.forward.attempts + 1;
    // A refusal that retrying cannot change, or a spent budget, means stop asking.
    if (!isRetryable(reason) || attempts >= MAX_AUTO_ATTEMPTS) {
      await this.#give_up(document, describe(reason));
      return 'failed';
    }
    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'pending',
      attempts,
      nextAt: this.#ports.now() + backoffMs(attempts, this.#ports.jitter()),
      error: describe(reason),
    });
    return 'waiting';
  }

  async #give_up(document: DocumentRecord, error: string): Promise<void> {
    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'failed',
      attempts: document.forward.attempts + 1,
      nextAt: null,
      error,
    });
  }

  async #taskIdFor(document: DocumentRecord): Promise<string | null> {
    return this.#storage.forwardTaskId(document.sha256);
  }
}

function describe(reason: FailureReason): string {
  return reason.kind === 'server_error' || reason.kind === 'auth' || reason.kind === 'rejected'
    ? `${reason.kind} (${String(reason.status)})`
    : reason.kind;
}
