import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DocumentPatch, DocumentRecord, PutOutcome, Suggestions } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

/**
 * Content-addressed storage, the same idea the client uses on the phone: bytes live
 * at the address of their own hash, so a path can never point at the wrong document
 * and writing the same document twice is a no-op rather than a conflict.
 */
export interface StorageOptions {
  readonly driver: SqlDriver;
  readonly objectsDir: string;
}

export interface SuggestionCandidate {
  readonly sha256: string;
  readonly remoteId: string;
  readonly attempts: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (
     sha256         TEXT PRIMARY KEY,
     bytes          INTEGER NOT NULL,
     page_count     INTEGER,
     received_at    INTEGER NOT NULL,
     title          TEXT,
     correspondent  TEXT,
     document_type  TEXT,
     tags           TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE INDEX IF NOT EXISTS documents_by_received ON documents (received_at DESC)`,
];

/**
 * Columns added after the first release. Applied by comparing against
 * `PRAGMA table_info` rather than by tracking a version number, because a missing
 * column is the thing we actually care about and it is directly observable.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['forward_state', `TEXT NOT NULL DEFAULT 'pending'`],
  ['forward_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['forward_next_at', 'INTEGER'],
  ['forward_task_id', 'TEXT'],
  ['forward_error', 'TEXT'],
  ['remote_id', 'TEXT'],
  // Set once, the moment forward_state becomes 'done'. Retention counts from here,
  // not from received_at, because it is a promise about the downstream system
  // having the document, not about how long we have known about it.
  ['forward_done_at', 'INTEGER'],
  ['bytes_released', 'INTEGER NOT NULL DEFAULT 0'],
  // A document only becomes eligible once remote_id is known, so this tracks
  // separately from forwarding rather than reusing its columns: a document can be
  // forwarded and never classified, or classified long after, and neither state
  // machine should have to know about the other's retry budget.
  ['suggestions_state', `TEXT NOT NULL DEFAULT 'pending'`],
  ['suggestions_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['suggestions_next_at', 'INTEGER'],
  ['suggestions_json', 'TEXT'],
];

interface Row {
  sha256: string;
  forward_state: string;
  forward_attempts: number;
  forward_next_at: number | null;
  forward_task_id: string | null;
  forward_error: string | null;
  remote_id: string | null;
  forward_done_at: number | null;
  bytes_released: number;
  suggestions_state: string;
  suggestions_attempts: number;
  suggestions_next_at: number | null;
  suggestions_json: string | null;
  bytes: number;
  page_count: number | null;
  received_at: number;
  title: string | null;
  correspondent: string | null;
  document_type: string | null;
  tags: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Storage {
  // Written out rather than declared as constructor parameter properties: Node
  // runs this file by stripping types, which cannot handle TypeScript syntax that
  // emits code. Anything not erasable fails at startup rather than at build time.
  readonly #driver: SqlDriver;
  readonly #objectsDir: string;

  private constructor(driver: SqlDriver, objectsDir: string) {
    this.#driver = driver;
    this.#objectsDir = objectsDir;
  }

  static async open(options: StorageOptions): Promise<Storage> {
    for (const statement of SCHEMA) await options.driver.exec(statement);

    const existing = await options.driver.all<{ name: string }>('PRAGMA table_info(documents)');
    const present = new Set(existing.map((column) => column.name));
    for (const [name, definition] of ADDED_COLUMNS) {
      if (!present.has(name)) {
        await options.driver.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
      }
    }
    await options.driver.exec(
      `CREATE INDEX IF NOT EXISTS documents_by_forward ON documents (forward_state, forward_next_at)`,
    );
    await options.driver.exec(
      `CREATE INDEX IF NOT EXISTS documents_by_release ON documents (forward_state, bytes_released, forward_done_at)`,
    );
    await options.driver.exec(
      `CREATE INDEX IF NOT EXISTS documents_by_suggestions ON documents (suggestions_state, suggestions_next_at)`,
    );

    mkdirSync(options.objectsDir, { recursive: true });
    return new Storage(options.driver, options.objectsDir);
  }

  /**
   * Store bytes under their own hash.
   *
   * Returns which of the two successes happened. Both mean "the server has this
   * document"; the difference only matters for reporting. Writing goes to a
   * temporary file first and is then renamed, so a crash mid-write cannot leave a
   * half-written object at an address that claims to hold a complete one.
   */
  async put(
    sha256: string,
    bytes: Uint8Array,
    now: number,
    pageCount: number | null,
  ): Promise<PutOutcome> {
    if (await this.has(sha256)) return 'already-stored';

    const target = this.pathFor(sha256);
    mkdirSync(join(this.#objectsDir, sha256.slice(0, 2)), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);

    await this.#driver.run(
      `INSERT INTO documents (sha256, bytes, page_count, received_at, tags)
       VALUES (?, ?, ?, ?, '[]')
       ON CONFLICT(sha256) DO NOTHING`,
      [sha256, bytes.length, pageCount, now],
    );
    return 'stored';
  }

  async has(sha256: string): Promise<boolean> {
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM documents WHERE sha256 = ?',
      [sha256],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  async record(sha256: string): Promise<DocumentRecord | null> {
    const rows = await this.#driver.all<Row>('SELECT * FROM documents WHERE sha256 = ?', [sha256]);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  bytes(sha256: string): Uint8Array | null {
    const path = this.pathFor(sha256);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  async list(limit = 200): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      'SELECT * FROM documents ORDER BY received_at DESC, sha256 ASC LIMIT ?',
      [limit],
    );
    return rows.map(toRecord);
  }

  async count(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
    return rows[0]?.n ?? 0;
  }

  /** Applies only the fields present. `null` clears; omitted leaves alone. */
  async patch(sha256: string, patch: DocumentPatch): Promise<DocumentRecord | null> {
    if (!(await this.has(sha256))) return null;

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const assign = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    assign('title', patch.title);
    assign('correspondent', patch.correspondent);
    assign('document_type', patch.documentType);
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      values.push(JSON.stringify(patch.tags));
    }

    if (sets.length > 0) {
      values.push(sha256);
      await this.#driver.run(`UPDATE documents SET ${sets.join(', ')} WHERE sha256 = ?`, values);
    }
    return this.record(sha256);
  }

  /** Documents due to be handed on, oldest first so nothing starves. */
  async dueForForwarding(now: number, limit = 20): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      `SELECT * FROM documents
        WHERE forward_state IN ('pending', 'sent')
          AND (forward_next_at IS NULL OR forward_next_at <= ?)
        ORDER BY received_at ASC
        LIMIT ?`,
      [now, limit],
    );
    return rows.map(toRecord);
  }

  async recordForwardAttempt(
    sha256: string,
    update: {
      state: 'pending' | 'sent' | 'done' | 'failed';
      attempts: number;
      nextAt: number | null;
      taskId?: string | null;
      remoteId?: string | null;
      error?: string | null;
      /** Only meaningful (and only ever passed) alongside `state: 'done'`. */
      doneAt?: number;
    },
  ): Promise<void> {
    await this.#driver.run(
      `UPDATE documents
          SET forward_state = ?, forward_attempts = ?, forward_next_at = ?,
              forward_task_id = COALESCE(?, forward_task_id),
              remote_id = COALESCE(?, remote_id),
              forward_error = ?,
              forward_done_at = COALESCE(forward_done_at, ?)
        WHERE sha256 = ?`,
      [
        update.state,
        update.attempts,
        update.nextAt,
        update.taskId ?? null,
        update.remoteId ?? null,
        update.error ?? null,
        update.doneAt ?? null,
        sha256,
      ],
    );
  }

  /**
   * Documents Paperless has held for at least `retentionMs`, and whose bytes are
   * still here to free. Oldest completion first, so a backlog drains in the order
   * it built up rather than leaving early arrivals waiting behind later ones.
   */
  async dueForRelease(
    now: number,
    retentionMs: number,
    limit = 50,
  ): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      `SELECT * FROM documents
        WHERE forward_state = 'done' AND bytes_released = 0
          AND forward_done_at IS NOT NULL AND forward_done_at <= ?
        ORDER BY forward_done_at ASC
        LIMIT ?`,
      [now - retentionMs, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Free the bytes for a document Paperless already has. The row survives: metadata,
   * forwarding history and the fact that this document existed are all worth
   * keeping, and none of them are the reason storage grows without bound.
   *
   * Idempotent, and safe to call on a file that is already gone -- retention that
   * crashes between unlinking and recording it must not fail the next time it finds
   * the same document due.
   */
  async release(sha256: string): Promise<void> {
    try {
      unlinkSync(this.pathFor(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.#driver.run('UPDATE documents SET bytes_released = 1 WHERE sha256 = ?', [sha256]);
  }

  async forwardTaskId(sha256: string): Promise<string | null> {
    const rows = await this.#driver.all<{ forward_task_id: string | null }>(
      'SELECT forward_task_id FROM documents WHERE sha256 = ?',
      [sha256],
    );
    return rows[0]?.forward_task_id ?? null;
  }

  async forwardCounts(): Promise<Readonly<Record<string, number>>> {
    const rows = await this.#driver.all<{ forward_state: string; n: number }>(
      'SELECT forward_state, COUNT(*) AS n FROM documents GROUP BY forward_state',
    );
    return Object.fromEntries(rows.map((row) => [row.forward_state, row.n]));
  }

  /** How many documents retention has actually freed the bytes for, so far. */
  async releasedCount(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM documents WHERE bytes_released = 1',
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Documents the downstream system has, but has not yet been asked what its
   * classifier makes of. Only ever a document with a `remote_id`: asking before
   * that would be asking about a document the target may not have finished
   * consuming yet.
   *
   * A purpose-built shape rather than `DocumentRecord`: `suggestions_attempts` is
   * retry bookkeeping for the fetcher, not something the wire contract needs to
   * carry.
   */
  async dueForSuggestions(now: number, limit = 20): Promise<readonly SuggestionCandidate[]> {
    const rows = await this.#driver.all<{
      sha256: string;
      remote_id: string;
      suggestions_attempts: number;
    }>(
      `SELECT sha256, remote_id, suggestions_attempts FROM documents
        WHERE forward_state = 'done' AND remote_id IS NOT NULL
          AND suggestions_state = 'pending'
          AND (suggestions_next_at IS NULL OR suggestions_next_at <= ?)
        ORDER BY received_at ASC
        LIMIT ?`,
      [now, limit],
    );
    return rows.map((row) => ({
      sha256: row.sha256,
      remoteId: row.remote_id,
      attempts: row.suggestions_attempts,
    }));
  }

  async recordSuggestionAttempt(
    sha256: string,
    update: {
      state: 'pending' | 'done' | 'abandoned';
      attempts: number;
      nextAt: number | null;
      /** Only meaningful, and only ever passed, alongside `state: 'done'`. */
      suggestions?: Suggestions;
    },
  ): Promise<void> {
    await this.#driver.run(
      `UPDATE documents
          SET suggestions_state = ?, suggestions_attempts = ?, suggestions_next_at = ?,
              suggestions_json = COALESCE(?, suggestions_json)
        WHERE sha256 = ?`,
      [
        update.state,
        update.attempts,
        update.nextAt,
        update.suggestions === undefined ? null : JSON.stringify(update.suggestions),
        sha256,
      ],
    );
  }

  private pathFor(sha256: string): string {
    // Two-character fan-out keeps any one directory from growing without bound.
    return join(this.#objectsDir, sha256.slice(0, 2), `${sha256}.pdf`);
  }
}

function toRecord(row: Row): DocumentRecord {
  return {
    sha256: row.sha256,
    bytes: row.bytes,
    pageCount: row.page_count,
    receivedAt: row.received_at,
    title: row.title,
    correspondent: row.correspondent,
    documentType: row.document_type,
    tags: JSON.parse(row.tags) as string[],
    forward: {
      state: row.forward_state as DocumentRecord['forward']['state'],
      attempts: row.forward_attempts,
      remoteId: row.remote_id,
      error: row.forward_error,
    },
    bytesReleased: row.bytes_released === 1,
    suggestions:
      row.suggestions_json === null ? null : (JSON.parse(row.suggestions_json) as Suggestions),
  };
}
