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
  AccessLevel,
  AccuracyResponse,
  DocumentFilter,
  DocumentPermissions,
  DocumentPatch,
  DocumentRecord,
  HistoryEvent,
  InboxEntry,
  Note,
  PutOutcome,
  SearchHit,
  SearchResponse,
  Suggestions,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { FIELD_NAMES, type ExtractedFields, type Usage } from '@sheaf/extract';
import { migrate } from './migrations.ts';
import { NearDuplicates } from './near-duplicates.ts';
import { accuracy } from './accuracy.ts';
import { describe as describeChange } from './audit.ts';

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

/** One run of an extractor over a document, as the extract step hands it over. */
export interface ExtractionRecord {
  readonly version: number;
  readonly provider: string;
  readonly model: string;
  readonly fields: ExtractedFields;
  readonly usage: Usage;
  readonly latencyMs: number;
}

/** A field's current value, and whether a machine or a person decided it. */
export interface FieldRow {
  readonly name: string;
  readonly value: unknown;
  readonly source: 'machine' | 'user';
  readonly confidence: number;
  readonly updatedAt: number;
}

/** A document as the archive lists it: its stable archive id and what is known. */
export interface ArchiveRow {
  readonly id: number;
  readonly sha256: string;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly receivedAt: number;
  /** The date on the document, when a person set one. */
  readonly created: string | null;
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

/** Job steps whose result depends on a document's text, and so go stale with it. */
const TEXT_READERS = ['extract'] as const;

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
         d.document_type, d.tags, d.created, d.asn, d.owner_id, d.bytes_released, d.suggestions_state,
         d.suggestions_attempts, d.suggestions_next_at, d.suggestions_json, d.trashed_at,
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
  trashed_at: number | null;
  bytes: number;
  page_count: number | null;
  received_at: number;
  title: string | null;
  correspondent: string | null;
  document_type: string | null;
  tags: string;
  created: string | null;
  asn: number | null;
  owner_id: number | null;
}

/**
 * The SQL that keeps a non-admin user to the documents they may see: shared with
 * everyone, theirs, or shared with them. `viewer` null: no limit.
 */
export function visibleTo(viewer: number | null, alias = 'd'): { sql: string; params: number[] } {
  if (viewer === null) return { sql: '1 = 1', params: [] };
  return {
    sql: `(${alias}.owner_id IS NULL OR ${alias}.owner_id = ?
           OR EXISTS (SELECT 1 FROM document_grants g WHERE g.sha256 = ${alias}.sha256 AND g.user_id = ?))`,
    params: [viewer, viewer],
  };
}

/** What became of a request to give a document a new file. */
export type ReplaceOutcome =
  | { readonly kind: 'replaced'; readonly sha256: string }
  | { readonly kind: 'unchanged'; readonly sha256: string }
  | { readonly kind: 'exists'; readonly sha256: string }
  | { readonly kind: 'not_found' };

/** An earlier file of a document. */
export interface DocumentVersion {
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number | null;
  /** When the document moved on from it. */
  readonly replacedAt: number;
}

/** Another document already has the archive serial number a patch asked for. */
export class AsnTaken extends Error {
  readonly asn: number;
  constructor(asn: number) {
    super(`archive serial number ${String(asn)} belongs to another document`);
    this.asn = asn;
  }
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
  /** The last operation queued on each document's file; see `#exclusive`. */
  readonly #fileLocks = new Map<string, Promise<unknown>>();

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
    /** The paired phone that sent it, or null for the admin token. */
    deviceId: string | null = null,
    /** The user it belongs to, when a person uploaded it; null shares it with everyone. */
    ownerId: number | null = null,
  ): Promise<PutOutcome> {
    return this.#exclusive(sha256, () =>
      this.#put(sha256, bytes, now, pageCount, deviceId, ownerId),
    );
  }

  async #put(
    sha256: string,
    bytes: Uint8Array,
    now: number,
    pageCount: number | null,
    deviceId: string | null,
    ownerId: number | null,
  ): Promise<PutOutcome> {
    if (await this.has(sha256)) {
      // Sending a document again is asking to keep it. One in the trash comes back
      // rather than being counted as synced and then deleted when the trash expires.
      await this.restore([sha256]);
      return 'already-stored';
    }

    this.#writeObject(sha256, bytes);

    await this.#driver.transaction(async () => {
      await this.#driver.run(
        `INSERT INTO documents (sha256, bytes, page_count, received_at, tags, device_id, owner_id)
         VALUES (?, ?, ?, ?, '[]', ?, ?)
         ON CONFLICT(sha256) DO NOTHING`,
        [sha256, bytes.length, pageCount, now, deviceId, ownerId],
      );
      await this.#driver.run('INSERT OR IGNORE INTO archive_ids (sha256) VALUES (?)', [sha256]);
      await this.reindex(sha256);
    });
    return 'stored';
  }

  /** Which paired phone first delivered a document; null for the admin token. */
  async deviceOf(sha256: string): Promise<string | null> {
    const rows = await this.#driver.all<{ device_id: string | null }>(
      'SELECT device_id FROM documents WHERE sha256 = ?',
      [sha256],
    );
    return rows[0]?.device_id ?? null;
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

  async list(limit = 200, viewer: number | null = null): Promise<readonly DocumentRecord[]> {
    const visible = visibleTo(viewer);
    const rows = await this.#driver.all<Row>(
      `${WITH_DELIVERY} WHERE d.trashed_at IS NULL AND ${visible.sql}
        ORDER BY d.received_at DESC, d.sha256 ASC LIMIT ?`,
      [PRIMARY_CONNECTOR, ...visible.params, limit],
    );
    return rows.map(toRecord);
  }

  async count(): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM documents WHERE trashed_at IS NULL',
    );
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
      // New or different text makes the document's extraction stale: clear it, and
      // the job runner queues it again. Resending identical text clears nothing.
      await this.#driver.run(
        `DELETE FROM jobs
          WHERE sha256 = ? AND step IN (${TEXT_READERS.map(() => '?').join(', ')})
            AND NOT EXISTS (
              SELECT 1 FROM document_text
               WHERE sha256 = ? AND source = ? AND engine = ? AND text = ?)`,
        [sha256, ...TEXT_READERS, sha256, body.source, body.engine, body.text],
      );
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
      await new NearDuplicates(this.#driver).update(sha256);
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
  async patch(
    sha256: string,
    patch: DocumentPatch,
    now: number = Date.now(),
  ): Promise<DocumentRecord | null> {
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
    assign('created', patch.created);
    if (patch.asn !== undefined) {
      sets.push('asn = ?');
      values.push(patch.asn);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      values.push(JSON.stringify(await this.withAncestors(patch.tags)));
    }
    if (patch.asn !== undefined && patch.asn !== null) {
      const holder = await this.#driver.all<{ sha256: string }>(
        'SELECT sha256 FROM documents WHERE asn = ? AND sha256 <> ?',
        [patch.asn, sha256],
      );
      if (holder.length > 0) throw new AsnTaken(patch.asn);
    }

    if (sets.length > 0) {
      values.push(sha256);
      await this.#driver.transaction(async () => {
        try {
          await this.#driver.run(
            `UPDATE documents SET ${sets.join(', ')} WHERE sha256 = ?`,
            values,
          );
        } catch (error) {
          // Another request took the number between the check and the update.
          if (patch.asn != null && error instanceof Error && /UNIQUE/.test(error.message)) {
            throw new AsnTaken(patch.asn);
          }
          throw error;
        }
        if (typeof patch.correspondent === 'string') {
          await this.#addName('correspondent', patch.correspondent);
        }
        if (typeof patch.documentType === 'string') {
          await this.#addName('document_type', patch.documentType);
        }
        for (const tag of patch.tags ?? []) await this.#addName('tag', tag);
        await this.#recordUserFields(sha256, patch, now);
        await this.reindex(sha256);
      });
    }
    return this.record(sha256);
  }

  /**
   * Keep one extraction: the run itself, each field it found where no person has
   * set that field, and the suggestions the phone asks for. One transaction, so a
   * crash never leaves fields without the run that produced them.
   */
  async saveExtraction(sha256: string, run: ExtractionRecord, now: number): Promise<void> {
    await this.#driver.transaction(async () => {
      await this.#driver.run(
        `INSERT OR REPLACE INTO extractions
           (sha256, version, provider, model, fields_json, input_tokens, output_tokens,
            cost_usd, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sha256,
          run.version,
          run.provider,
          run.model,
          JSON.stringify(run.fields),
          run.usage.inputTokens,
          run.usage.outputTokens,
          run.usage.costUsd,
          run.latencyMs,
          now,
        ],
      );
      for (const name of FIELD_NAMES) {
        const field = run.fields[name];
        if (field === undefined) continue;
        await this.#driver.run(
          `INSERT INTO fields (sha256, name, value_json, source, confidence, updated_at)
           VALUES (?, ?, ?, 'machine', ?, ?)
           ON CONFLICT (sha256, name) DO UPDATE SET
             value_json = excluded.value_json,
             confidence = excluded.confidence,
             updated_at = excluded.updated_at
           WHERE fields.source = 'machine'`,
          [sha256, name, JSON.stringify(field.value), field.confidence, now],
        );
      }
      const suggestions: Suggestions = {
        ...(run.fields.title === undefined ? {} : { title: run.fields.title.value }),
        ...(run.fields.date === undefined ? {} : { date: run.fields.date.value }),
        ...(run.fields.correspondent === undefined
          ? {}
          : { correspondent: run.fields.correspondent.value }),
        ...(run.fields.documentType === undefined
          ? {}
          : { documentType: run.fields.documentType.value }),
        ...(run.fields.tags === undefined ? {} : { tags: run.fields.tags.value }),
      };
      await this.#driver.run(
        `UPDATE documents SET suggestions_json = ?, suggestions_state = 'done' WHERE sha256 = ?`,
        [JSON.stringify(suggestions), sha256],
      );
    });
  }

  /**
   * Answer "nothing to suggest" for a document extraction gave up on or had no text
   * for, so the phone stops asking. Never replaces a real answer.
   */
  async recordNoSuggestions(sha256: string): Promise<void> {
    await this.#driver.run(
      `UPDATE documents SET suggestions_json = '{}', suggestions_state = 'done'
        WHERE sha256 = ? AND suggestions_json IS NULL`,
      [sha256],
    );
  }

  async fields(sha256: string): Promise<readonly FieldRow[]> {
    const rows = await this.#driver.all<{
      name: string;
      value_json: string;
      source: 'machine' | 'user';
      confidence: number;
      updated_at: number;
    }>('SELECT * FROM fields WHERE sha256 = ? ORDER BY name', [sha256]);
    return rows.map((row) => ({
      name: row.name,
      value: JSON.parse(row.value_json) as unknown,
      source: row.source,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    }));
  }

  async extractionCount(sha256: string): Promise<number> {
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extractions WHERE sha256 = ?',
      [sha256],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Mark each field a person set, cleared included, as theirs. Extraction then
   * leaves it alone, however confident a later run is.
   */
  async #recordUserFields(sha256: string, patch: DocumentPatch, now: number): Promise<void> {
    const chosen: [string, unknown][] = [
      ['title', patch.title],
      ['correspondent', patch.correspondent],
      ['documentType', patch.documentType],
      ['tags', patch.tags],
      // The date extraction reads is the date on the document: a person setting it
      // keeps a later run from replacing it.
      ['date', patch.created],
      ['asn', patch.asn],
    ];
    for (const [name, value] of chosen) {
      if (value === undefined) continue;
      await this.#driver.run(
        `INSERT INTO fields (sha256, name, value_json, source, confidence, updated_at)
         VALUES (?, ?, ?, 'user', 1, ?)
         ON CONFLICT (sha256, name) DO UPDATE SET
           value_json = excluded.value_json, source = 'user', confidence = 1,
           updated_at = excluded.updated_at`,
        [sha256, name, JSON.stringify(value), now],
      );
    }
  }

  /** How often each field's suggestion was right, by what people kept. See `accuracy`. */
  async accuracy(): Promise<AccuracyResponse> {
    return accuracy(this.#driver);
  }

  /** Documents with suggestions that no person has acted on, newest first. */
  async inbox(limit = 100, viewer: number | null = null): Promise<readonly InboxEntry[]> {
    const visible = visibleTo(viewer);
    const twinVisible = visibleTo(viewer, 't');
    const rows = await this.#driver.all<{
      sha256: string;
      received_at: number;
      title: string | null;
      suggestions_json: string;
      twin: string | null;
      twin_title: string | null;
      twin_received_at: number | null;
      twin_similarity: number | null;
    }>(
      `SELECT d.sha256, d.received_at, d.title, d.suggestions_json,
              t.sha256 AS twin, t.title AS twin_title, t.received_at AS twin_received_at,
              s.twin_similarity
         FROM documents d
         LEFT JOIN text_signatures s ON s.sha256 = d.sha256
         LEFT JOIN documents t
           ON t.sha256 = s.twin AND t.trashed_at IS NULL AND ${twinVisible.sql}
        WHERE d.suggestions_json IS NOT NULL AND d.suggestions_json <> '{}'
          AND d.trashed_at IS NULL AND ${visible.sql}
          AND NOT EXISTS (SELECT 1 FROM fields f WHERE f.sha256 = d.sha256 AND f.source = 'user')
        ORDER BY d.received_at DESC, d.sha256
        LIMIT ?`,
      [...twinVisible.params, ...visible.params, limit],
    );
    return rows.map((row) => ({
      sha256: row.sha256,
      receivedAt: row.received_at,
      title: row.title,
      suggestions: JSON.parse(row.suggestions_json) as Suggestions,
      ...(row.twin === null
        ? {}
        : {
            looksLike: {
              sha256: row.twin,
              title: row.twin_title,
              receivedAt: row.twin_received_at!,
              similarity: row.twin_similarity!,
            },
          }),
    }));
  }

  /**
   * What happened to a document here, oldest first, built from timestamps already
   * kept for other reasons: nothing extra is written to have a history.
   */
  async history(sha256: string): Promise<readonly HistoryEvent[]> {
    const events: HistoryEvent[] = [];
    const received = await this.#driver.all<{ received_at: number; device: string | null }>(
      `SELECT d.received_at, v.name AS device FROM documents d
         LEFT JOIN devices v ON v.id = d.device_id WHERE d.sha256 = ?`,
      [sha256],
    );
    for (const row of received) {
      events.push({
        at: row.received_at,
        text: row.device === null ? 'Received' : `Received from ${row.device}`,
      });
    }
    for (const text of await this.texts(sha256)) {
      events.push({
        at: text.receivedAt,
        text:
          text.source === 'edge'
            ? `Text from the phone (${text.engine})`
            : `Text read on the server (${text.engine})`,
      });
    }
    const runs = await this.#driver.all<{ created_at: number; model: string }>(
      'SELECT created_at, model FROM extractions WHERE sha256 = ? ORDER BY created_at',
      [sha256],
    );
    for (const run of runs)
      events.push({ at: run.created_at, text: `Details read by ${run.model}` });
    const deliveries = await this.#driver.all<{ connector: string; done_at: number }>(
      'SELECT connector, done_at FROM deliveries WHERE sha256 = ? AND done_at IS NOT NULL',
      [sha256],
    );
    for (const d of deliveries) events.push({ at: d.done_at, text: `Delivered to ${d.connector}` });
    const given = await this.#driver.all<{ step: string; finished_at: number }>(
      `SELECT step, finished_at FROM jobs WHERE sha256 = ? AND state = 'given_up'`,
      [sha256],
    );
    for (const job of given) events.push({ at: job.finished_at, text: `Gave up on ${job.step}` });
    const edits = await this.#driver.all<{ updated_at: number; names: string }>(
      `SELECT updated_at, group_concat(name, ', ') AS names FROM fields
        WHERE sha256 = ? AND source = 'user' GROUP BY updated_at`,
      [sha256],
    );
    for (const edit of edits)
      events.push({ at: edit.updated_at, text: `You changed: ${edit.names}` });
    for (const note of await this.notes(sha256)) {
      events.push({
        at: note.createdAt,
        text: note.author === null ? 'Note added' : `Note added from ${note.author}`,
      });
    }
    // Who made each change, from the audit log: a named person or phone, when known.
    const changes = await this.#driver.all<{
      at: number;
      actor_kind: string;
      actor_name: string | null;
      device_name: string | null;
      method: string;
      path: string;
    }>(
      `SELECT a.at, a.actor_kind, a.actor_name, d.name AS device_name, a.method, a.path
         FROM audit_log a LEFT JOIN devices d ON a.actor_kind = 'device' AND d.id = a.actor_id
        WHERE a.sha256 = ? AND a.actor_kind <> 'admin'`,
      [sha256],
    );
    for (const change of changes) {
      const who = change.actor_name ?? change.device_name ?? 'a phone';
      events.push({
        at: change.at,
        text: `${describeChange(change.method, change.path)} (${who})`,
      });
    }
    return events.sort((a, b) => a.at - b.at);
  }

  /**
   * Move a document to the trash. It leaves lists, search, the inbox and the
   * archive at once, and stops being forwarded or worked on; nothing is deleted.
   * Trashing it again changes nothing, the time it was first trashed included.
   */
  async trash(sha256: string, now: number): Promise<boolean> {
    if (!(await this.has(sha256))) return false;
    await this.#driver.transaction(async () => {
      await this.#driver.run(
        'UPDATE documents SET trashed_at = ? WHERE sha256 = ? AND trashed_at IS NULL',
        [now, sha256],
      );
      await this.#driver.run('DELETE FROM documents_fts WHERE sha256 = ?', [sha256]);
    });
    return true;
  }

  /** Take documents back out of the trash. Returns how many were in it. */
  async restore(sha256s: readonly string[]): Promise<number> {
    return this.#driver.transaction(async () => {
      const ids = JSON.stringify(sha256s);
      const trashed = (
        await this.#driver.all<{ sha256: string }>(
          `SELECT sha256 FROM documents
            WHERE sha256 IN (SELECT value FROM json_each(?)) AND trashed_at IS NOT NULL`,
          [ids],
        )
      ).map((row) => row.sha256);
      await this.#driver.run(
        'UPDATE documents SET trashed_at = NULL WHERE sha256 IN (SELECT value FROM json_each(?))',
        [JSON.stringify(trashed)],
      );
      await this.reindexMany(trashed);
      return trashed.length;
    });
  }

  /** What is in the trash, most recently trashed first. */
  async trashed(viewer: number | null = null): Promise<
    readonly {
      sha256: string;
      title: string | null;
      suggestedTitle: string | null;
      receivedAt: number;
      trashedAt: number;
    }[]
  > {
    const rows = await this.#driver.all<{
      sha256: string;
      title: string | null;
      suggested_title: string | null;
      received_at: number;
      trashed_at: number;
    }>(
      `SELECT sha256, title, json_extract(suggestions_json, '$.title') AS suggested_title,
              received_at, trashed_at
         FROM documents d WHERE trashed_at IS NOT NULL AND ${visibleTo(viewer).sql}
        ORDER BY trashed_at DESC, sha256`,
      visibleTo(viewer).params,
    );
    return rows.map((row) => ({
      sha256: row.sha256,
      title: row.title,
      suggestedTitle: row.suggested_title,
      receivedAt: row.received_at,
      trashedAt: row.trashed_at,
    }));
  }

  /** Trashed documents whose time in the trash is up, oldest first. */
  async dueForPurge(now: number, keepMs: number, limit = 100): Promise<readonly string[]> {
    const rows = await this.#driver.all<{ sha256: string }>(
      `SELECT sha256 FROM documents
        WHERE trashed_at IS NOT NULL AND trashed_at <= ?
        ORDER BY trashed_at ASC LIMIT ?`,
      [now - keepMs, limit],
    );
    return rows.map((row) => row.sha256);
  }

  /**
   * Delete a trashed document for good: its file and everything known about it.
   * Refuses one that is not in the trash, so nothing reaches here by mistake.
   *
   * Its archive id is kept, unused, so a phone that cached it never sees that id
   * name a different document.
   */
  async purge(sha256: string): Promise<boolean> {
    return this.#exclusive(sha256, () => this.#purge(sha256));
  }

  async #purge(sha256: string): Promise<boolean> {
    const versionFiles: string[] = [];
    const deleted = await this.#driver.transaction(async () => {
      const trashed = await this.#driver.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM documents WHERE sha256 = ? AND trashed_at IS NOT NULL',
        [sha256],
      );
      if ((trashed[0]?.n ?? 0) === 0) return false;
      for (const table of [
        'documents_fts',
        'document_text',
        'notes',
        'custom_field_values',
        'fields',
        'extractions',
        'jobs',
        'deliveries',
        'share_links',
        'document_grants',
        'workflow_runs',
        'text_signatures',
        'documents',
      ]) {
        await this.#driver.run(`DELETE FROM ${table} WHERE sha256 = ?`, [sha256]);
      }
      await this.#driver.run('UPDATE text_signatures SET twin = NULL WHERE twin = ?', [sha256]);
      // Links to it from other documents go too. Left in place they would come back
      // to life, one-sided, if the same file were ever uploaded again.
      await this.#driver.run(
        `UPDATE custom_field_values
            SET value_json = (SELECT json_group_array(j.value)
                                FROM json_each(custom_field_values.value_json) j
                               WHERE j.value <> ?)
          WHERE field_id IN (SELECT id FROM custom_fields WHERE data_type = 'documentLink')
            AND EXISTS (SELECT 1 FROM json_each(custom_field_values.value_json) j
                         WHERE j.value = ?)`,
        [sha256, sha256],
      );
      for (const version of await this.versions(sha256)) versionFiles.push(version.sha256);
      await this.#driver.run('DELETE FROM document_versions WHERE document_sha256 = ?', [sha256]);
      return true;
    });
    // After the rows: a crash between the two leaves an orphaned file, which costs
    // disk space, never a row that points at a missing file. An upload of the same
    // document cannot slip in between: `put` waits on the same lock.
    if (deleted) {
      // Its earlier files go too, unless one has since become a document of its own.
      const keep = await Promise.all(versionFiles.map((version) => this.has(version)));
      for (const path of [sha256, ...versionFiles.filter((_, i) => !keep[i])].map((s) =>
        this.pathFor(s),
      )) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return deleted;
  }

  /**
   * Give a document a new file, keeping the one it had as an earlier version.
   *
   * Documents are named by their bytes, so the document moves to the new file's
   * hash: its details, text, notes, fields, history, share links and archive id all
   * go with it, and links from other documents follow. It is sent on again, being a
   * different file. Answers the new hash, or why not.
   */
  async replaceFile(
    sha256: string,
    bytes: Uint8Array,
    pageCount: number | null,
    now: number,
  ): Promise<ReplaceOutcome> {
    return this.#exclusive(sha256, async () => {
      const record = await this.record(sha256);
      if (record === null || record.trashedAt !== undefined) return { kind: 'not_found' };
      const next = sha256Hex(bytes);
      if (next === sha256) return { kind: 'unchanged', sha256 };
      if (await this.has(next)) return { kind: 'exists', sha256: next };
      this.#writeObject(next, bytes);
      await this.#driver.transaction(async () => {
        await this.#driver.run(
          `INSERT OR REPLACE INTO document_versions
             (document_sha256, version_sha256, bytes, page_count, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [next, sha256, record.bytes, record.pageCount, now],
        );
        await this.#rekey(sha256, next, bytes.length, pageCount);
      });
      return { kind: 'replaced', sha256: next };
    });
  }

  /** A document's earlier files, newest first. */
  async versions(sha256: string): Promise<readonly DocumentVersion[]> {
    const rows = await this.#driver.all<{
      version_sha256: string;
      bytes: number;
      page_count: number | null;
      created_at: number;
    }>(
      `SELECT version_sha256, bytes, page_count, created_at FROM document_versions
        WHERE document_sha256 = ? ORDER BY created_at DESC, rowid DESC`,
      [sha256],
    );
    return rows.map((row) => ({
      sha256: row.version_sha256,
      bytes: row.bytes,
      pageCount: row.page_count,
      replacedAt: row.created_at,
    }));
  }

  /** The bytes of one earlier version of a document, or null when it has no such version. */
  async versionBytes(sha256: string, version: string): Promise<Uint8Array | null> {
    if (!(await this.versions(sha256)).some((v) => v.sha256 === version)) return null;
    const path = this.pathFor(version);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  /** Make an earlier version the document's file again; the current one becomes a version. */
  async restoreVersion(sha256: string, version: string, now: number): Promise<ReplaceOutcome> {
    const bytes = await this.versionBytes(sha256, version);
    if (bytes === null) return { kind: 'not_found' };
    const outcome = await this.replaceFile(
      sha256,
      bytes,
      (await this.versions(sha256)).find((v) => v.sha256 === version)?.pageCount ?? null,
      now,
    );
    if (outcome.kind === 'replaced') {
      // It is the document again, not one of its earlier files.
      await this.#driver.run(
        'DELETE FROM document_versions WHERE document_sha256 = ? AND version_sha256 = ?',
        [version, version],
      );
    }
    return outcome;
  }

  /** Every row about `from` becomes about `to`, the new file's size and pages included. */
  async #rekey(from: string, to: string, bytes: number, pageCount: number | null): Promise<void> {
    for (const table of [
      'documents',
      'document_text',
      'notes',
      'custom_field_values',
      'fields',
      'extractions',
      'jobs',
      'share_links',
      'archive_ids',
      'audit_log',
      'document_grants',
      'workflow_runs',
      'text_signatures',
    ]) {
      await this.#driver.run(`UPDATE ${table} SET sha256 = ? WHERE sha256 = ?`, [to, from]);
    }
    await this.#driver.run('UPDATE text_signatures SET twin = ? WHERE twin = ?', [to, from]);
    await this.#driver.run(
      'UPDATE document_versions SET document_sha256 = ? WHERE document_sha256 = ?',
      [to, from],
    );
    await this.#driver.run(
      'UPDATE documents SET bytes = ?, page_count = ?, bytes_released = 0 WHERE sha256 = ?',
      [bytes, pageCount, to],
    );
    // A different file: whatever was sent on before was the old one.
    await this.#driver.run('DELETE FROM deliveries WHERE sha256 = ?', [from]);
    await this.#driver.run(
      `UPDATE custom_field_values
          SET value_json = (SELECT json_group_array(CASE WHEN j.value = ? THEN ? ELSE j.value END)
                              FROM json_each(custom_field_values.value_json) j)
        WHERE field_id IN (SELECT id FROM custom_fields WHERE data_type = 'documentLink')
          AND EXISTS (SELECT 1 FROM json_each(custom_field_values.value_json) j WHERE j.value = ?)`,
      [from, to, from],
    );
    await this.#driver.run('DELETE FROM documents_fts WHERE sha256 = ?', [from]);
    await this.reindex(to);
  }

  #writeObject(sha256: string, bytes: Uint8Array): void {
    const target = this.pathFor(sha256);
    mkdirSync(join(this.#objectsDir, sha256.slice(0, 2)), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);
  }

  /**
   * Keep a note on a document, and make it searchable in the same transaction.
   * Returns null for a document this server does not hold.
   */
  async addNote(
    sha256: string,
    text: string,
    deviceId: string | null,
    now: number,
  ): Promise<Note | null> {
    if (!(await this.has(sha256))) return null;
    const id = await this.#driver.transaction(async () => {
      await this.#driver.run(
        'INSERT INTO notes (sha256, text, device_id, created_at) VALUES (?, ?, ?, ?)',
        [sha256, text, deviceId, now],
      );
      const rows = await this.#driver.all<{ id: number }>('SELECT last_insert_rowid() AS id');
      await this.reindex(sha256);
      return rows[0]!.id;
    });
    return (await this.notes(sha256)).find((note) => note.id === id) ?? null;
  }

  /** A document's notes, oldest first, each with the name of the phone that wrote it. */
  async notes(sha256: string): Promise<readonly Note[]> {
    const rows = await this.#driver.all<{
      id: number;
      text: string;
      author: string | null;
      created_at: number;
    }>(
      `SELECT n.id, n.text, v.name AS author, n.created_at FROM notes n
         LEFT JOIN devices v ON v.id = n.device_id
        WHERE n.sha256 = ? ORDER BY n.created_at, n.id`,
      [sha256],
    );
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      author: row.author,
      createdAt: row.created_at,
    }));
  }

  /** Remove one note of one document. False when there is no such note on it. */
  async deleteNote(sha256: string, id: number): Promise<boolean> {
    return this.#driver.transaction(async () => {
      const found = await this.#driver.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM notes WHERE sha256 = ? AND id = ?',
        [sha256, id],
      );
      if ((found[0]?.n ?? 0) === 0) return false;
      await this.#driver.run('DELETE FROM notes WHERE sha256 = ? AND id = ?', [sha256, id]);
      await this.reindex(sha256);
      return true;
    });
  }

  /**
   * Change what a document is filed under on the server's own account, as a
   * workflow does: nothing is recorded as a person's choice. `null` clears.
   */
  async fileByMachine(
    sha256: string,
    change: {
      readonly title?: string | null;
      readonly correspondent?: string | null;
      readonly documentType?: string | null;
      readonly tags?: readonly string[];
      readonly created?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    for (const [column, value] of [
      ['title', change.title],
      ['created', change.created],
      ['correspondent', change.correspondent],
      ['document_type', change.documentType],
    ] as const) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (change.tags !== undefined) {
      sets.push('tags = ?');
      values.push(JSON.stringify(await this.withAncestors(change.tags)));
    }
    if (sets.length === 0) return;
    await this.#driver.transaction(async () => {
      await this.#driver.run(`UPDATE documents SET ${sets.join(', ')} WHERE sha256 = ?`, [
        ...values,
        sha256,
      ]);
      if (typeof change.correspondent === 'string') {
        await this.#addName('correspondent', change.correspondent);
      }
      if (typeof change.documentType === 'string') {
        await this.#addName('document_type', change.documentType);
      }
      for (const tag of change.tags ?? []) await this.#addName('tag', tag);
      await this.reindex(sha256);
    });
  }

  /**
   * Add tags without recording them as a person's choice, the way a consume
   * folder's subfolders do: rules may still add more. Answers the tags now there.
   */
  async addTags(sha256: string, tags: readonly string[]): Promise<readonly string[] | null> {
    const record = await this.record(sha256);
    if (record === null) return null;
    const next = await this.withAncestors([...record.tags, ...tags]);
    if (next.length === record.tags.length) return record.tags;
    await this.#driver.transaction(async () => {
      await this.#driver.run('UPDATE documents SET tags = ? WHERE sha256 = ?', [
        JSON.stringify(next),
        sha256,
      ]);
      for (const tag of tags) await this.#addName('tag', tag);
      await this.reindex(sha256);
    });
    return next;
  }

  /**
   * Give a document a serial number read off it, if it has none and no other
   * document has that number. True when it took.
   */
  async setAsnIfFree(sha256: string, asn: number): Promise<boolean> {
    const changed = await this.#driver.all<{ n: number }>(
      `UPDATE documents SET asn = ?
        WHERE sha256 = ? AND asn IS NULL
          AND NOT EXISTS (SELECT 1 FROM documents WHERE asn = ?)
       RETURNING 1 AS n`,
      [asn, sha256, asn],
    );
    return changed.length > 0;
  }

  /**
   * The tags, each followed by the tags it sits inside that are not there yet: a
   * document filed under a tag is filed under its parents too. Unknown tags are
   * kept as they are.
   */
  async withAncestors(tags: readonly string[]): Promise<string[]> {
    const unique = [...new Set(tags)];
    if (unique.length === 0) return unique;
    const rows = await this.#driver.all<{ child: string; ancestor: string; depth: number }>(
      `WITH RECURSIVE up(child, id, depth) AS (
         SELECT name, parent_id, 1 FROM names
          WHERE kind = 'tag' AND parent_id IS NOT NULL AND name IN (${unique.map(() => '?').join(', ')})
         UNION ALL
         SELECT up.child, n.parent_id, up.depth + 1 FROM up JOIN names n ON n.id = up.id
          WHERE n.parent_id IS NOT NULL AND up.depth < 10
       )
       SELECT up.child, n.name AS ancestor, up.depth FROM up JOIN names n ON n.id = up.id
        ORDER BY up.depth`,
      unique,
    );
    const out: string[] = [];
    for (const tag of unique) {
      out.push(tag);
      for (const row of rows) if (row.child === tag) out.push(row.ancestor);
    }
    return [...new Set(out)];
  }

  /** Put a tag's parents on every document that has it, after the tag was given a parent. */
  async fillInAncestors(tag: string): Promise<void> {
    const rows = await this.#driver.all<{ sha256: string; tags: string }>(
      `SELECT sha256, tags FROM documents d WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)`,
      [tag],
    );
    for (const row of rows) {
      const tags = JSON.parse(row.tags) as string[];
      const next = await this.withAncestors(tags);
      if (next.length === tags.length) continue;
      await this.#driver.run('UPDATE documents SET tags = ? WHERE sha256 = ?', [
        JSON.stringify(next),
        row.sha256,
      ]);
      await this.reindex(row.sha256);
    }
  }

  /**
   * What a user may do with a document: change it (shared with everyone, theirs, or
   * shared with them to change), only see it, or neither. Null for no such document.
   */
  async access(sha256: string, user: number): Promise<'change' | 'view' | 'none' | null> {
    const rows = await this.#driver.all<{ owner_id: number | null; level: string | null }>(
      `SELECT d.owner_id, g.level FROM documents d
         LEFT JOIN document_grants g ON g.sha256 = d.sha256 AND g.user_id = ?
        WHERE d.sha256 = ?`,
      [user, sha256],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (row.owner_id === null || row.owner_id === user) return 'change';
    return row.level === 'change' ? 'change' : row.level === 'view' ? 'view' : 'none';
  }

  async permissions(sha256: string): Promise<DocumentPermissions | null> {
    const owner = await this.#driver.all<{ owner_id: number | null }>(
      'SELECT owner_id FROM documents WHERE sha256 = ?',
      [sha256],
    );
    if (owner[0] === undefined) return null;
    const grants = await this.#driver.all<{ user_id: number; level: AccessLevel }>(
      'SELECT user_id, level FROM document_grants WHERE sha256 = ? ORDER BY user_id',
      [sha256],
    );
    return {
      owner: owner[0].owner_id,
      grants: grants.map((grant) => ({ user: grant.user_id, level: grant.level })),
    };
  }

  /** Replace who owns a document and whom it is shared with. */
  async setPermissions(sha256: string, permissions: DocumentPermissions): Promise<void> {
    await this.#driver.transaction(async () => {
      await this.#driver.run('UPDATE documents SET owner_id = ? WHERE sha256 = ?', [
        permissions.owner,
        sha256,
      ]);
      await this.#driver.run('DELETE FROM document_grants WHERE sha256 = ?', [sha256]);
      for (const grant of permissions.grants) {
        if (grant.user === permissions.owner) continue;
        await this.#driver.run(
          'INSERT INTO document_grants (sha256, user_id, level) VALUES (?, ?, ?)',
          [sha256, grant.user, grant.level],
        );
      }
    });
  }

  /** One more than the highest archive serial number in use, trash included. */
  async nextAsn(): Promise<number> {
    const rows = await this.#driver.all<{ n: number | null }>(
      'SELECT MAX(asn) AS n FROM documents',
    );
    return (rows[0]?.n ?? 0) + 1;
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
              d.created,
              ${PLAIN_EXCERPT} AS excerpt
         FROM archive_ids a JOIN documents d ON d.sha256 = a.sha256
        WHERE a.id = ? AND d.trashed_at IS NULL`,
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
    const where: string[] = ['d.trashed_at IS NULL'];
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
      WHERE ${where.join(' AND ')}`;

    const rows = await this.#driver.all<ArchiveSqlRow>(
      `SELECT a.id, d.sha256, d.title, d.correspondent, d.document_type, d.tags, d.received_at,
              d.created,
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
    await this.reindexMany([sha256]);
  }

  /**
   * `reindex` for many documents at once. The index's sha256 column is not indexed,
   * so each delete scans the whole index: one statement for the lot costs one scan,
   * where a loop of `reindex` would cost one scan per document.
   */
  async reindexMany(sha256s: readonly string[]): Promise<void> {
    if (sha256s.length === 0) return;
    const ids = JSON.stringify(sha256s);
    await this.#driver.run(
      'DELETE FROM documents_fts WHERE sha256 IN (SELECT value FROM json_each(?))',
      [ids],
    );
    await this.#driver.run(
      `INSERT INTO documents_fts (sha256, title, correspondent, document_type, tags, body)
       SELECT d.sha256, COALESCE(d.title, ''), COALESCE(d.correspondent, ''),
              COALESCE(d.document_type, ''), d.tags,
              ltrim(
                COALESCE((SELECT group_concat(t.text, char(10)) FROM document_text t
                           WHERE t.sha256 = d.sha256), '')
                  || COALESCE((SELECT char(10) || group_concat(n.text, char(10)) FROM notes n
                                WHERE n.sha256 = d.sha256), '')
                  || COALESCE((SELECT char(10) || group_concat(${CUSTOM_FIELD_TEXT}, char(10))
                                 FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
                                WHERE v.sha256 = d.sha256 AND v.value_json <> 'null'), ''),
                char(10))
         FROM documents d
        WHERE d.sha256 IN (SELECT value FROM json_each(?)) AND d.trashed_at IS NULL`,
      [ids],
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
    const all = await this.#driver.all<{ sha256: string }>(
      'SELECT sha256 FROM documents WHERE trashed_at IS NULL',
    );
    const missing = all.map((row) => row.sha256).filter((sha256) => !indexed.has(sha256));
    for (let i = 0; i < missing.length; i += 200) {
      await this.#driver.transaction(async () => {
        await this.reindexMany(missing.slice(i, i + 200));
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
    return this.find(match, {}, limit, offset);
  }

  /**
   * Documents the filter lets through, outside the trash. With `match`, only those
   * whose text matches it, each with a snippet around the match; without, every one,
   * with no snippet.
   */
  async find(
    match: string | null,
    filter: DocumentFilter,
    limit: number,
    offset: number,
    viewer: number | null = null,
  ): Promise<SearchResponse> {
    const visible = visibleTo(viewer);
    const where = ['d.trashed_at IS NULL', visible.sql];
    const params: Array<string | number> = [...visible.params];
    const anyOf = (column: string, values: readonly string[] | undefined) => {
      if (values === undefined || values.length === 0) return;
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    const tagIn = (values: readonly string[]) =>
      `EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value IN (${values.map(() => '?').join(', ')}))`;

    if (match !== null) {
      where.push('documents_fts MATCH ?');
      params.push(match);
    }
    anyOf('d.correspondent', filter.correspondents);
    anyOf('d.document_type', filter.documentTypes);
    for (const tag of filter.tags ?? []) {
      where.push(tagIn([tag]));
      params.push(tag);
    }
    if (filter.anyTags !== undefined && filter.anyTags.length > 0) {
      where.push(tagIn(filter.anyTags));
      params.push(...filter.anyTags);
    }
    if (filter.notTags !== undefined && filter.notTags.length > 0) {
      where.push(`NOT ${tagIn(filter.notTags)}`);
      params.push(...filter.notTags);
    }
    if (filter.receivedFrom !== undefined) {
      where.push('d.received_at >= ?');
      params.push(Date.parse(`${filter.receivedFrom}T00:00:00Z`));
    }
    if (filter.receivedTo !== undefined) {
      where.push('d.received_at < ?');
      params.push(Date.parse(`${filter.receivedTo}T00:00:00Z`) + 86_400_000);
    }
    if (filter.createdFrom !== undefined) {
      where.push('d.created >= ?');
      params.push(filter.createdFrom);
    }
    if (filter.createdTo !== undefined) {
      where.push('d.created <= ?');
      params.push(filter.createdTo);
    }
    if (filter.asn !== undefined) {
      where.push('d.asn = ?');
      params.push(filter.asn);
    }
    for (const field of filter.fields ?? []) {
      where.push(
        'EXISTS (SELECT 1 FROM custom_field_values v WHERE v.sha256 = d.sha256 AND v.field_id = ?)',
      );
      params.push(field);
    }

    const from =
      match === null ? 'documents d' : 'documents_fts f JOIN documents d ON d.sha256 = f.sha256';
    const sort = filter.sort ?? (match === null ? 'newest' : 'relevance');
    const order = {
      relevance:
        match === null
          ? 'd.received_at DESC'
          : 'bm25(documents_fts, 0, 10, 5, 5, 3, 1), d.received_at DESC',
      newest: 'd.received_at DESC',
      oldest: 'd.received_at ASC',
      created: 'd.created IS NULL, d.created DESC, d.received_at DESC',
      asn: 'd.asn IS NULL, d.asn ASC',
      title: `COALESCE(d.title, json_extract(d.suggestions_json, '$.title'), '~') COLLATE NOCASE,
              d.received_at DESC`,
    }[sort];
    const condition = where.join(' AND ');

    const rows = await this.#driver.all<{
      sha256: string;
      title: string | null;
      correspondent: string | null;
      document_type: string | null;
      tags: string;
      received_at: number;
      created: string | null;
      asn: number | null;
      snippet: string;
      suggested_title: string | null;
    }>(
      `SELECT d.sha256, d.title, d.correspondent, d.document_type, d.tags, d.received_at,
              d.created, d.asn, json_extract(d.suggestions_json, '$.title') AS suggested_title,
              ${match === null ? "''" : "snippet(documents_fts, -1, '«', '»', '…', 12)"} AS snippet
         FROM ${from}
        WHERE ${condition}
        ORDER BY ${order}, d.sha256
        LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset],
    );
    // The total costs a second pass over the matches, so it is only counted when the
    // page does not already show them all, and straight from the index when the
    // words are all there is to it: trashed documents are never in the index.
    const onlyWords = match !== null && where.length === 3 && viewer === null;
    const total =
      offset === 0 && rows.length <= limit
        ? rows.length
        : ((
            await this.#driver.all<{ n: number }>(
              onlyWords
                ? 'SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?'
                : `SELECT COUNT(*) AS n FROM ${from} WHERE ${condition}`,
              onlyWords ? [match] : params,
            )
          )[0]?.n ?? 0);
    const hits: SearchHit[] = rows.slice(0, limit).map((row) => ({
      sha256: row.sha256,
      title: row.title,
      suggestedTitle: row.suggested_title,
      correspondent: row.correspondent,
      documentType: row.document_type,
      tags: JSON.parse(row.tags) as string[],
      receivedAt: row.received_at,
      created: row.created,
      asn: row.asn,
      snippet: row.snippet,
    }));
    return { hits, hasMore: rows.length > limit, total };
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
          AND d.trashed_at IS NULL
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
          AND d.trashed_at IS NULL
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

  /**
   * Run `work` once every earlier operation on this document's file has finished.
   * Uploading and purging both write the file and its row in two steps; without
   * this, an upload landing between a purge's two steps would lose its file.
   * In-process only, which is enough: one server process owns the data directory.
   */
  async #exclusive<T>(sha256: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#fileLocks.get(sha256) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.catch(() => undefined);
    this.#fileLocks.set(sha256, settled);
    try {
      return await result;
    } finally {
      if (this.#fileLocks.get(sha256) === settled) this.#fileLocks.delete(sha256);
    }
  }

  /** Where a document's file is on disk, whether or not it is there. */
  pathFor(sha256: string): string {
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
  created: string | null;
  excerpt: string | null;
}

/**
 * What of a custom field value is searchable: its field's name and, for the types
 * that hold words or numbers, the value. Links and yes/no answers say nothing a
 * search could match.
 */
const CUSTOM_FIELD_TEXT = `f.name || ': ' || CASE
    WHEN f.data_type IN ('text', 'url', 'select', 'date', 'integer', 'number')
      THEN json_extract(v.value_json, '$')
    WHEN f.data_type = 'monetary' THEN json_extract(v.value_json, '$.currency')
    ELSE '' END`;

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
    created: row.created,
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
    created: row.created,
    asn: row.asn,
    owner: row.owner_id,
    forward: {
      state: row.f_state as DocumentRecord['forward']['state'],
      attempts: row.f_attempts,
      remoteId: row.f_remote_id,
      error: row.f_error,
    },
    bytesReleased: row.bytes_released === 1,
    suggestions:
      row.suggestions_json === null ? null : (JSON.parse(row.suggestions_json) as Suggestions),
    ...(row.trashed_at === null ? {} : { trashedAt: row.trashed_at }),
  };
}
