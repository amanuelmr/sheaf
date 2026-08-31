import type { Storage } from './storage.ts';

export interface RetentionPorts {
  now(): number;
}

export interface RetentionResult {
  readonly released: number;
}

/**
 * Frees the disk space held by documents Paperless has confirmed it already has.
 *
 * Every other retention decision in this project defaults to keeping the extra
 * copy -- `keepLocalAfterSync` on the phone is conservative by default for the same
 * reason. This one is off unless a `retentionMs` is configured (see main.ts):
 * nobody is watching an outbox on a server the way a phone's owner watches theirs,
 * so freeing bytes automatically only happens once someone has decided Paperless is
 * trustworthy enough to be the sole remaining copy.
 *
 * Deliberately independent of forwarding. A document only becomes due once
 * `forward_state` is `'done'`, but from there this runs on its own schedule: the
 * bytes are never on the critical path for whether forwarding succeeds, so
 * retention lagging behind it -- or stopping entirely -- can never turn into a lost
 * hand-off.
 */
export class Retention {
  readonly #storage: Storage;
  readonly #retentionMs: number;
  readonly #ports: RetentionPorts;

  constructor(storage: Storage, retentionMs: number, ports: RetentionPorts) {
    this.#storage = storage;
    this.#retentionMs = retentionMs;
    this.#ports = ports;
  }

  /** One pass over everything currently eligible. */
  async tick(): Promise<RetentionResult> {
    const due = await this.#storage.dueForRelease(this.#ports.now(), this.#retentionMs);
    for (const document of due) {
      await this.#storage.release(document.sha256);
    }
    return { released: due.length };
  }
}
