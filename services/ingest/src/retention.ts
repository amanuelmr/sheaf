import type { Storage } from './storage.ts';

export interface RetentionPorts {
  now(): number;
}

export interface RetentionResult {
  readonly released: number;
}

/**
 * Frees the disk space held by documents one named connector has confirmed it holds.
 *
 * Every other retention decision in this project defaults to keeping the extra
 * copy -- `keepLocalAfterSync` on the phone is conservative by default for the same
 * reason. This one is off unless a `retentionMs` is configured (see main.ts):
 * nobody is watching an outbox on a server the way a phone's owner watches theirs,
 * so freeing bytes automatically only happens once someone has decided which
 * connector is trustworthy enough to be the sole remaining copy -- and says so by
 * name, since with Sheaf as the system of record (ADR 0007) no connector is assumed
 * to be the archive.
 *
 * Deliberately independent of forwarding. A document only becomes due once its
 * delivery to that connector is `'done'`, but from there this runs on its own schedule: the
 * bytes are never on the critical path for whether forwarding succeeds, so
 * retention lagging behind it -- or stopping entirely -- can never turn into a lost
 * hand-off.
 */
export class Retention {
  readonly #storage: Storage;
  readonly #retentionMs: number;
  readonly #connector: string;
  readonly #ports: RetentionPorts;

  constructor(storage: Storage, retentionMs: number, connector: string, ports: RetentionPorts) {
    this.#storage = storage;
    this.#retentionMs = retentionMs;
    this.#connector = connector;
    this.#ports = ports;
  }

  /** One pass over everything currently eligible. */
  async tick(): Promise<RetentionResult> {
    const due = await this.#storage.dueForRelease(
      this.#ports.now(),
      this.#retentionMs,
      this.#connector,
    );
    for (const document of due) {
      await this.#storage.release(document.sha256);
    }
    return { released: due.length };
  }
}
