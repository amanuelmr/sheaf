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
import type {
  DocumentPatch,
  DocumentRecord,
  PutOutcome,
  SearchHit,
  SearchResponse,
  Suggestions,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { migrate } from './migrations.ts';

/**
 * Content-addressed storage, the same idea the client uses on the phone: bytes live
 * at the address of their own hash, so a path can never point at the wrong document
 * and writing the same document twice is a no-op rather than a conflict.
 */
export interface StorageOptions {
  readonly driver: SqlDriver;
  readonly objectsDir: string;
}

export type NameKind = 'correspondent' | 'document_type' | 'tag';

/** A document as the archive lists it: its stable archive id and what is known. */
export interface ArchiveRow {
  readonly id: number;
  readonly sha256: string;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly receivedAt: number;
  /** The start of its text, or the part around a search match. */
  readonly excerpt: string | null;
}

export interface ArchiveFilter {
  /** An FTS5 query from `toMatch`, or null to list everything. */
  readonly match: string | null;
  readonly correspondent?: string;
  readonly documentType?: string;
  readonly tag?: string;
}

/**
 * Text to keep for a document. The phone's `DocumentTextBody` is one of these; a
 * server-side recogniser supplies its own source name.
 */
export interface TextInput {
  readonly source: string;
  readonly engine: string;
  readonly text: string;
}

/** Text recognised in a document, as one source last reported it. */
export interface StoredText {
  readonly source: string;
  readonly engine: string;
  readonly text: string;
  readonly receivedAt: number;
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

/**
 * The connector whose progress a v1 `DocumentRecord.forward` reports. Clients of
 * protocol v1 only know of one downstream system, and it was always Paperless.
 */
export const PRIMARY_CONNECTOR = 'paperless';

/**
 * A document joined with its delivery to one connector. A document with no row
 * for that connector has not been sent there yet, which reads as `pending`.
 */
const WITH_DELIVERY = `
  SELECT d.sha256, d.bytes, d.page_count, d.received_at, d.title, d.correspondent,
         d.document_type, d.tags, d.bytes_released, d.suggestions_state,
         d.suggestions_attempts, d.suggestions_next_at, d.suggestions_json,
         COALESCE(v.state, 'pending') AS f_state, COALESCE(v.attempts, 0) AS f_attempts,
         v.next_at AS f_next_at, v.task_id AS f_task_id, v.remote_id AS f_remote_id,
         v.error AS f_error, v.done_at AS f_done_at
    FROM documents d
    LEFT JOIN deliveries v ON v.sha256 = d.sha256 AND v.connector = ?`;

interface Row {
  sha256: string;
  f_state: string;
  f_attempts: number;
  f_next_at: number | null;
  f_task_id: string | null;
  f_error: string | null;
  f_remote_id: string | null;
  f_done_at: number | null;
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

    // Tables added since the column-adding scheme above, in order and once each.
    // `applied_at` is diagnostic only, so the wall clock is fine here.
    await migrate(options.driver, Date.now());

    mkdirSync(options.objectsDir, { recursive: true });
    const storage = new Storage(options.driver, options.objectsDir);
    // Documents stored before the index existed, or while a reindex was cut short,
    // become searchable here rather than whenever they next happen to change.
    await storage.reindexMissing();
    return storage;
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

    await this.#driver.transaction(async () => {
      await this.#driver.run(
        `INSERT INTO documents (sha256, bytes, page_count, received_at, tags)
         VALUES (?, ?, ?, ?, '[]')
         ON CONFLICT(sha256) DO NOTHING`,
        [sha256, bytes.length, pageCount, now],
      );
      await this.#driver.run('INSERT OR IGNORE INTO archive_ids (sha256) VALUES (?)', [sha256]);
      await this.reindex(sha256);
    });
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
    const rows = await this.#driver.all<Row>(`${WITH_DELIVERY} WHERE d.sha256 = ?`, [
      PRIMARY_CONNECTOR,
      sha256,
    ]);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  bytes(sha256: string): Uint8Array | null {
    const path = this.pathFor(sha256);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  async list(limit = 200): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      `${WITH_DELIVERY} ORDER BY d.received_at DESC, d.sha256 ASC LIMIT ?`,
      [PRIMARY_CONNECTOR, limit],
    );
    return rows.map(toRecord);
  }

  async count(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
    return rows[0]?.n ?? 0;
  }

  /**
   * Keep the text one source recognised in a stored document. Sending the same
   * text again leaves the row exactly as it was, `receivedAt` included, so a client
   * retrying after a lost reply changes nothing.
   */
  async putText(
    sha256: string,
    body: TextInput,
    now: number,
  ): Promise<'stored' | 'unknown-document'> {
    if (!(await this.has(sha256))) return 'unknown-document';
    await this.#driver.transaction(async () => {
      await this.#driver.run(
        `INSERT INTO document_text (sha256, source, engine, text, received_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sha256, source) DO UPDATE SET
           engine = excluded.engine,
           text = excluded.text,
           received_at = excluded.received_at
         WHERE document_text.text <> excluded.text OR document_text.engine <> excluded.engine`,
        [sha256, body.source, body.engine, body.text, now],
      );
      await this.reindex(sha256);
    });
    return 'stored';
  }

  async texts(sha256: string): Promise<readonly StoredText[]> {
    const rows = await this.#driver.all<{
      source: string;
      engine: string;
      text: string;
      received_at: number;
    }>(
      'SELECT source, engine, text, received_at FROM document_text WHERE sha256 = ? ORDER BY source',
      [sha256],
    );
    return rows.map((row) => ({
      source: row.source,
      engine: row.engine,
      text: row.text,
      receivedAt: row.received_at,
    }));
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
      await this.#driver.transaction(async () => {
        await this.#driver.run(`UPDATE documents SET ${sets.join(', ')} WHERE sha256 = ?`, values);
        if (typeof patch.correspondent === 'string') {
          await this.#addName('correspondent', patch.correspondent);
        }
        if (typeof patch.documentType === 'string') {
          await this.#addName('document_type', patch.documentType);
        }
        for (const tag of patch.tags ?? []) await this.#addName('tag', tag);
        await this.reindex(sha256);
      });
    }
    return this.record(sha256);
  }

  async #addName(kind: NameKind, name: string): Promise<void> {
    await this.#driver.run('INSERT OR IGNORE INTO names (kind, name) VALUES (?, ?)', [kind, name]);
  }

  /** Every name of one kind, alphabetically, with its stable id. */
  async names(kind: NameKind): Promise<readonly { id: number; name: string }[]> {
    return this.#driver.all<{ id: number; name: string }>(
      'SELECT id, name FROM names WHERE kind = ? ORDER BY name COLLATE NOCASE, id',
      [kind],
    );
  }

  async nameFor(kind: NameKind, id: number): Promise<string | null> {
    const rows = await this.#driver.all<{ name: string }>(
      'SELECT name FROM names WHERE kind = ? AND id = ?',
      [kind, id],
    );
    return rows[0]?.name ?? null;
  }

  async archiveIdFor(sha256: string): Promise<number | null> {
    const rows = await this.#driver.all<{ id: number }>(
      'SELECT id FROM archive_ids WHERE sha256 = ?',
      [sha256],
    );
    return rows[0]?.id ?? null;
  }

  async archiveRow(id: number): Promise<ArchiveRow | null> {
    const rows = await this.#driver.all<ArchiveSqlRow>(
      `SELECT a.id, d.sha256, d.title, d.correspondent, d.document_type, d.tags, d.received_at,
              ${PLAIN_EXCERPT} AS excerpt
         FROM archive_ids a JOIN documents d ON d.sha256 = a.sha256
        WHERE a.id = ?`,
      [id],
    );
    return rows[0] === undefined ? null : toArchiveRow(rows[0]);
  }

  /**
   * One page of the archive: newest first, or best match first when searching.
   * `total` counts every match, so a client can say how many there are.
   */
  async archivePage(
    filter: ArchiveFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: readonly ArchiveRow[]; total: number }> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.match !== null) {
      where.push('documents_fts MATCH ?');
      params.push(filter.match);
    }
    if (filter.correspondent !== undefined) {
      where.push('d.correspondent = ?');
      params.push(filter.correspondent);
    }
    if (filter.documentType !== undefined) {
      where.push('d.document_type = ?');
      params.push(filter.documentType);
    }
    if (filter.tag !== undefined) {
      where.push('EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)');
      params.push(filter.tag);
    }
    const from = `FROM archive_ids a JOIN documents d ON d.sha256 = a.sha256
      ${filter.match === null ? '' : 'JOIN documents_fts f ON f.sha256 = d.sha256'}
      ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}`;

    const rows = await this.#driver.all<ArchiveSqlRow>(
      `SELECT a.id, d.sha256, d.title, d.correspondent, d.document_type, d.tags, d.received_at,
              ${filter.match === null ? PLAIN_EXCERPT : "snippet(documents_fts, -1, '', '', '…', 24)"}
                AS excerpt
         ${from}
        ORDER BY ${filter.match === null ? '' : 'bm25(documents_fts, 0, 10, 5, 5, 3, 1),'}
                 d.received_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const counted = await this.#driver.all<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, params);
    return { rows: rows.map(toArchiveRow), total: counted[0]?.n ?? 0 };
  }

  /**
   * Rewrite one document's search entry from what is stored now: its details and
   * every source of text. Called inside the same transaction as each change, so the
   * index never describes a state that was not committed.
   */
  async reindex(sha256: string): Promise<void> {
    await this.#driver.run('DELETE FROM documents_fts WHERE sha256 = ?', [sha256]);
    await this.#driver.run(
      `INSERT INTO documents_fts (sha256, title, correspondent, document_type, tags, body)
       SELECT d.sha256, COALESCE(d.title, ''), COALESCE(d.correspondent, ''),
              COALESCE(d.document_type, ''), d.tags,
              COALESCE((SELECT group_concat(t.text, char(10)) FROM document_text t
                         WHERE t.sha256 = d.sha256), '')
         FROM documents d
        WHERE d.sha256 = ?`,
      [sha256],
    );
  }

  /** Index every stored document that has no search entry yet. */
  async reindexMissing(): Promise<number> {
    // One pass over each table rather than a correlated lookup per document: the
    // index's sha256 column is not indexed, and a query per row would be quadratic.
    const indexed = new Set(
      (await this.#driver.all<{ sha256: string }>('SELECT sha256 FROM documents_fts')).map(
        (row) => row.sha256,
      ),
    );
    const all = await this.#driver.all<{ sha256: string }>('SELECT sha256 FROM documents');
    const missing = all.map((row) => row.sha256).filter((sha256) => !indexed.has(sha256));
    for (let i = 0; i < missing.length; i += 200) {
      await this.#driver.transaction(async () => {
        for (const sha256 of missing.slice(i, i + 200)) await this.reindex(sha256);
      });
    }
    return missing.length;
  }

  async indexedCount(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM documents_fts');
    return rows[0]?.n ?? 0;
  }

  /**
   * Best matches first for an FTS5 `match` built by `toMatch`, never by hand.
   * Column weights rank the title above names and tags, and those above body text.
   */
  async search(match: string, limit: number, offset: number): Promise<SearchResponse> {
    const rows = await this.#driver.all<{
      sha256: string;
      title: string | null;
      correspondent: string | null;
      document_type: string | null;
      tags: string;
      received_at: number;
      snippet: string;
    }>(
      `SELECT d.sha256, d.title, d.correspondent, d.document_type, d.tags, d.received_at,
              snippet(documents_fts, -1, '«', '»', '…', 12) AS snippet
         FROM documents_fts f
         JOIN documents d ON d.sha256 = f.sha256
        WHERE documents_fts MATCH ?
        ORDER BY bm25(documents_fts, 0, 10, 5, 5, 3, 1), d.received_at DESC
        LIMIT ? OFFSET ?`,
      [match, limit + 1, offset],
    );
    const hits: SearchHit[] = rows.slice(0, limit).map((row) => ({
      sha256: row.sha256,
      title: row.title,
      correspondent: row.correspondent,
      documentType: row.document_type,
      tags: JSON.parse(row.tags) as string[],
      receivedAt: row.received_at,
      snippet: row.snippet,
    }));
    return { hits, hasMore: rows.length > limit };
  }

  /**
   * Documents due to be handed to one connector, oldest first so nothing starves.
   * Each record's `forward` describes its delivery to that connector.
   */
  async dueForForwarding(
    now: number,
    connector: string,
    limit = 20,
  ): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      `${WITH_DELIVERY}
        WHERE COALESCE(v.state, 'pending') IN ('pending', 'sent')
          AND (v.next_at IS NULL OR v.next_at <= ?)
        ORDER BY d.received_at ASC
        LIMIT ?`,
      [connector, now, limit],
    );
    return rows.map(toRecord);
  }

  async recordForwardAttempt(
    sha256: string,
    connector: string,
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
    // An upsert: the first attempt for a connector creates its row. Task id, remote
    // id and completion time are kept once known, exactly as the columns this
    // replaced kept them.
    await this.#driver.run(
      `INSERT INTO deliveries
         (sha256, connector, state, attempts, next_at, task_id, remote_id, error, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sha256, connector) DO UPDATE SET
         state = excluded.state,
         attempts = excluded.attempts,
         next_at = excluded.next_at,
         task_id = COALESCE(excluded.task_id, deliveries.task_id),
         remote_id = COALESCE(excluded.remote_id, deliveries.remote_id),
         error = excluded.error,
         done_at = COALESCE(deliveries.done_at, excluded.done_at)`,
      [
        sha256,
        connector,
        update.state,
        update.attempts,
        update.nextAt,
        update.taskId ?? null,
        update.remoteId ?? null,
        update.error ?? null,
        update.doneAt ?? null,
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
    connector: string,
    limit = 50,
  ): Promise<readonly DocumentRecord[]> {
    const rows = await this.#driver.all<Row>(
      `${WITH_DELIVERY}
        WHERE v.state = 'done' AND d.bytes_released = 0
          AND v.done_at IS NOT NULL AND v.done_at <= ?
        ORDER BY v.done_at ASC
        LIMIT ?`,
      [connector, now - retentionMs, limit],
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

  async forwardTaskId(sha256: string, connector: string): Promise<string | null> {
    const rows = await this.#driver.all<{ task_id: string | null }>(
      'SELECT task_id FROM deliveries WHERE sha256 = ? AND connector = ?',
      [sha256, connector],
    );
    return rows[0]?.task_id ?? null;
  }

  /** Documents by delivery state for one connector; never-sent documents count as pending. */
  async forwardCounts(connector: string): Promise<Readonly<Record<string, number>>> {
    const rows = await this.#driver.all<{ state: string; n: number }>(
      `SELECT COALESCE(v.state, 'pending') AS state, COUNT(*) AS n
         FROM documents d
         LEFT JOIN deliveries v ON v.sha256 = d.sha256 AND v.connector = ?
        GROUP BY 1`,
      [connector],
    );
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
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
  async dueForSuggestions(
    now: number,
    connector: string,
    limit = 20,
  ): Promise<readonly SuggestionCandidate[]> {
    const rows = await this.#driver.all<{
      sha256: string;
      remote_id: string;
      suggestions_attempts: number;
    }>(
      `SELECT d.sha256, v.remote_id, d.suggestions_attempts
         FROM documents d
         JOIN deliveries v ON v.sha256 = d.sha256 AND v.connector = ?
        WHERE v.state = 'done' AND v.remote_id IS NOT NULL
          AND d.suggestions_state = 'pending'
          AND (d.suggestions_next_at IS NULL OR d.suggestions_next_at <= ?)
        ORDER BY d.received_at ASC
        LIMIT ?`,
      [connector, now, limit],
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

interface ArchiveSqlRow {
  id: number;
  sha256: string;
  title: string | null;
  correspondent: string | null;
  document_type: string | null;
  tags: string;
  received_at: number;
  excerpt: string | null;
}

/** The first 200 characters of a document's text, from whichever source has some. */
const PLAIN_EXCERPT = `(SELECT substr(group_concat(t.text, ' '), 1, 200)
                         FROM document_text t WHERE t.sha256 = d.sha256)`;

function toArchiveRow(row: ArchiveSqlRow): ArchiveRow {
  return {
    id: row.id,
    sha256: row.sha256,
    title: row.title,
    correspondent: row.correspondent,
    documentType: row.document_type,
    tags: JSON.parse(row.tags) as string[],
    receivedAt: row.received_at,
    excerpt: row.excerpt === '' ? null : row.excerpt,
  };
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
      state: row.f_state as DocumentRecord['forward']['state'],
      attempts: row.f_attempts,
      remoteId: row.f_remote_id,
      error: row.f_error,
    },
    bytesReleased: row.bytes_released === 1,
    suggestions:
      row.suggestions_json === null ? null : (JSON.parse(row.suggestions_json) as Suggestions),
  };
}
