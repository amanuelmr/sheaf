import type { Storage } from './storage.ts';

export interface TrashSweeperPorts {
  now(): number;
}

/** Days a document stays in the trash unless `SHEAF_TRASH_DAYS` says otherwise. */
export const DEFAULT_TRASH_DAYS = 30;

/**
 * Deletes for good what has been in the trash longer than it may stay.
 *
 * Only ever touches trashed documents (`Storage.purge` refuses anything else), so
 * a wrong clock or a bad setting can empty the trash early, never delete a document
 * someone did not delete first.
 */
export class TrashSweeper {
  readonly #storage: Storage;
  readonly #keepMs: number;
  readonly #ports: TrashSweeperPorts;

  constructor(storage: Storage, keepMs: number, ports: TrashSweeperPorts) {
    this.#storage = storage;
    this.#keepMs = keepMs;
    this.#ports = ports;
  }

  /** One pass: purge everything currently due. */
  async tick(): Promise<{ purged: number }> {
    let purged = 0;
    for (const sha256 of await this.#storage.dueForPurge(this.#ports.now(), this.#keepMs)) {
      if (await this.#storage.purge(sha256)) purged++;
    }
    return { purged };
  }
}
