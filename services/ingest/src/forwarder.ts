import { backoffMs, isRetryable } from '@sheaf/core';
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
  /**
   * Find a hand-off the target has accepted but not yet finished, by the content it
   * carried.
   *
   * Optional, and narrower than `locate` on purpose: it answers during the window
   * when the document does not exist yet but a task for it does.
   */
  locateTask?(sha256: string): Promise<ApiResult<string | null>>;
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
    //
    // A failed question is not a no. Reading an unreachable target as "it does not
    // have this" and sending anyway is how a network blip becomes a duplicate, so a
    // question we could not ask means wait, not proceed.
    if (this.#target.locate !== undefined) {
      const already = await this.#target.locate(document.sha256);
      if (!already.ok) return this.#backOff(document, already.reason, 'pending');
      if (already.value !== null) {
        await this.#storage.recordForwardAttempt(document.sha256, {
          state: 'done',
          attempts: document.forward.attempts,
          nextAt: null,
          remoteId: already.value,
          error: null,
        });
        return 'completed';
      }
    }

    const bytes = this.#storage.bytes(document.sha256);
    if (bytes === null) {
      // The object is gone from disk. Retrying cannot conjure it back, so stop
      // rather than loop on it forever.
      await this.#give_up(document, 'the stored bytes are missing');
      return 'failed';
    }

    // Write down that an attempt is under way BEFORE making it, and stay in that
    // state if it appears to fail. Asking `locate` first is not enough on its own:
    // it answers "do you hold this document", and there is a window where the
    // target has taken the bytes and not finished consuming them, during which the
    // honest answer is no. A process that died in that window used to come back
    // with nothing written down, and send again. The simulator found it duplicating
    // documents on a merely flaky target, not a hostile one.
    //
    // This is the same discipline the phone's log uses, where the attempt is
    // recorded before the request rather than after it.
    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'sent',
      attempts: document.forward.attempts + 1,
      nextAt: null,
      error: null,
    });

    const sent = await this.#target.send(document, bytes);
    if (!sent.ok) return this.#backOff(document, sent.reason, 'sent');

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
    // We recorded that a hand-off was under way and never recorded what came back,
    // so either we died mid-request or the reply was lost. Both mean the same thing:
    // we do not know whether the target took the bytes, and guessing is exactly the
    // move that creates a second document. Ask it.
    if (taskId === null) return this.#adopt(document);

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

  /**
   * Best effort, and only for naming something already known to have arrived. The
   * decision of whether to send is not allowed to use this: there, a failure to ask
   * and an answer of no are different things.
   */
  async #locate(sha256: string): Promise<string | null> {
    if (this.#target.locate === undefined) return null;
    const found = await this.#target.locate(sha256);
    return found.ok ? found.value : null;
  }

  /**
   * Resolve an attempt whose outcome we never learned, by asking the target whether
   * it is already holding one.
   *
   * A target that cannot be asked leaves us where we started: send again, and
   * accept that a hand-off it silently accepted becomes a second document there.
   * That is a property of the target, not a choice made here -- and the one we
   * actually ship can be asked.
   */
  async #adopt(document: DocumentRecord): Promise<'completed' | 'failed' | 'waiting'> {
    if (this.#target.locateTask === undefined) return this.#restart(document);

    const found = await this.#target.locateTask(document.sha256);
    // Could not ask. That is not evidence of anything, so wait rather than resend.
    if (!found.ok) return this.#backOff(document, found.reason, 'sent');
    if (found.value === null) return this.#restart(document);

    await this.#storage.recordForwardAttempt(document.sha256, {
      state: 'sent',
      attempts: document.forward.attempts,
      nextAt: null,
      taskId: found.value,
      error: null,
    });
    return 'waiting';
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

  /**
   * Back off, and choose what the failure leaves us believing.
   *
   * `'pending'` means nothing is outstanding: the failure happened somewhere that
   * cannot have handed the bytes over. `'sent'` means it might have -- a send whose
   * reply never arrived looks identical to one that never left -- so the next pass
   * asks the target instead of assuming.
   */
  async #backOff(
    document: DocumentRecord,
    reason: FailureReason,
    unresolved: 'pending' | 'sent' = 'pending',
  ): Promise<'failed' | 'waiting'> {
    const attempts = document.forward.attempts + 1;
    // A refusal that retrying cannot change means stop asking. Anything else does
    // not, however long it has been going on.
    //
    // Deliberately not the phone's attempt budget, which this used to borrow. That
    // budget exists because stopping there means asking the user, and a phone
    // retrying for ever costs battery on a network that may be hopeless. None of it
    // applies here: nobody is watching, the document has been safe since it was
    // stored, and a target that is down for an hour while it upgrades is ordinary.
    // Giving up on the fifth try would have meant a document sitting un-forwarded
    // until somebody happened to look.
    //
    // The backoff ladder caps at five minutes, so "for ever" costs one request per
    // document per five minutes, and `/v1/health` reports the backlog and the reason.
    if (!isRetryable(reason)) {
      await this.#give_up(document, describe(reason));
      return 'failed';
    }
    await this.#storage.recordForwardAttempt(document.sha256, {
      state: unresolved,
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
