import type { SqlDriver } from '@sheaf/store';

/**
 * Ordered, run-once schema changes.
 *
 * `storage.ts` adds columns by comparing against `PRAGMA table_info`, which is the
 * right tool for "this column should exist" and stays for the columns it already
 * manages. It cannot express "create this table and copy that data into it, once",
 * which is what the standalone server's new tables need. Those go here.
 *
 * Each migration runs inside one transaction together with the row recording it,
 * so a crash leaves it either fully applied and recorded, or neither.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/** ISO 4217 currencies with thousandths, ten-thousandths, and no minor unit (bar JPY and KRW). */
const MINOR_3 = `'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'`;
const MINOR_4 = `'CLF', 'UYW'`;
const MINOR_0_WAS_2 = `'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'KMF', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'`;

/**
 * Rescale the amount at `at` (an object with `minor` and `currency`) in one JSON
 * column, from the old rule (cents for all but JPY and KRW) to ISO 4217's unit.
 */
function rescaleMoney(table: string, column: string, at: string, where: string): string {
  const currency = `json_extract(${column}, '${at}.currency')`;
  return `UPDATE ${table}
             SET ${column} = json_set(${column}, '${at}.minor', CAST(round(
                   json_extract(${column}, '${at}.minor') * CASE
                     WHEN ${currency} IN (${MINOR_3}) THEN 10
                     WHEN ${currency} IN (${MINOR_4}) THEN 100
                     ELSE 0.01 END) AS INTEGER))
           WHERE ${where} AND ${currency} IN (${MINOR_3}, ${MINOR_4}, ${MINOR_0_WAS_2})`;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'jobs',
    statements: [
      `CREATE TABLE jobs (
         sha256      TEXT    NOT NULL,
         step        TEXT    NOT NULL,
         version     INTEGER NOT NULL,
         state       TEXT    NOT NULL
                     CHECK (state IN ('pending', 'running', 'done', 'skipped', 'given_up')),
         attempts    INTEGER NOT NULL DEFAULT 0,
         next_at     INTEGER,
         last_error  TEXT,
         created_at  INTEGER NOT NULL,
         finished_at INTEGER,
         PRIMARY KEY (sha256, step, version)
       )`,
      `CREATE INDEX jobs_due ON jobs (state, next_at)`,
    ],
  },
  {
    // One row per document per connector (ADR 0007), replacing the forward_*
    // columns on documents, which assumed a single downstream system. Those columns
    // stay, unread: dropping them buys nothing and risks the one migration nobody
    // can undo. A document with no row for a connector has not been sent there yet.
    id: 2,
    name: 'deliveries',
    statements: [
      `CREATE TABLE deliveries (
         sha256    TEXT    NOT NULL,
         connector TEXT    NOT NULL,
         state     TEXT    NOT NULL CHECK (state IN ('pending', 'sent', 'done', 'failed')),
         attempts  INTEGER NOT NULL DEFAULT 0,
         next_at   INTEGER,
         task_id   TEXT,
         remote_id TEXT,
         error     TEXT,
         done_at   INTEGER,
         PRIMARY KEY (sha256, connector)
       )`,
      `CREATE INDEX deliveries_due ON deliveries (connector, state, next_at)`,
      // Everything a server forwarded before connectors existed went to Paperless,
      // the only target there was. Untouched documents need no row.
      `INSERT INTO deliveries
         (sha256, connector, state, attempts, next_at, task_id, remote_id, error, done_at)
       SELECT sha256, 'paperless', forward_state, forward_attempts, forward_next_at,
              forward_task_id, remote_id, forward_error, forward_done_at
         FROM documents
        WHERE forward_state <> 'pending' OR forward_attempts > 0 OR forward_task_id IS NOT NULL`,
    ],
  },
  {
    // Recognised text per document and source (ADR 0009). The phone's on-device OCR
    // is the first source; a server-side fallback is the second. Keeping both lets
    // search use either and lets their quality be compared.
    id: 3,
    name: 'document_text',
    statements: [
      `CREATE TABLE document_text (
         sha256      TEXT    NOT NULL,
         source      TEXT    NOT NULL,
         engine      TEXT    NOT NULL,
         text        TEXT    NOT NULL,
         received_at INTEGER NOT NULL,
         PRIMARY KEY (sha256, source)
       )`,
    ],
  },
  {
    // Full-text search over everything known about a document (ADR 0007). A plain
    // FTS5 table, kept in step by `Storage.reindex` rather than by triggers across
    // documents and document_text: one function to read is easier to trust than
    // four triggers. Accents are folded, so "cafe" finds "Café".
    id: 4,
    name: 'documents_fts',
    statements: [
      `CREATE VIRTUAL TABLE documents_fts USING fts5(
         sha256 UNINDEXED, title, correspondent, document_type, tags, body,
         tokenize = 'unicode61 remove_diacritics 2'
       )`,
    ],
  },
  {
    // The archive's ids. Protocol v1 names archive documents by positive integer,
    // which Paperless supplies; served from our own catalog they need one too. Not
    // `documents.rowid`: a table with a text primary key may renumber its rowids on
    // VACUUM, and the phone caches these ids. An INTEGER PRIMARY KEY never moves.
    //
    // And names for the archive's vocabulary, which edits by id as well. Documents
    // keep their details as text; this only gives each distinct name a stable id.
    id: 5,
    name: 'archive_ids_and_names',
    statements: [
      `CREATE TABLE archive_ids (
         id     INTEGER PRIMARY KEY,
         sha256 TEXT    NOT NULL UNIQUE
       )`,
      `INSERT INTO archive_ids (sha256)
       SELECT sha256 FROM documents ORDER BY received_at ASC, sha256 ASC`,
      `CREATE TABLE names (
         id   INTEGER PRIMARY KEY,
         kind TEXT    NOT NULL CHECK (kind IN ('correspondent', 'document_type', 'tag')),
         name TEXT    NOT NULL,
         UNIQUE (kind, name)
       )`,
      `INSERT OR IGNORE INTO names (kind, name)
       SELECT 'correspondent', correspondent FROM documents WHERE correspondent IS NOT NULL`,
      `INSERT OR IGNORE INTO names (kind, name)
       SELECT 'document_type', document_type FROM documents WHERE document_type IS NOT NULL`,
      `INSERT OR IGNORE INTO names (kind, name)
       SELECT 'tag', t.value FROM documents d, json_each(d.tags) t`,
    ],
  },
  {
    // Extraction (ADR 0010). `extractions` keeps every run by version, so a new
    // prompt or provider can be compared with the last. `fields` is what each field
    // is now and who decided it: a person's choice is never overwritten by a machine.
    id: 6,
    name: 'extraction',
    statements: [
      `CREATE TABLE extractions (
         sha256        TEXT    NOT NULL,
         version       INTEGER NOT NULL,
         provider      TEXT    NOT NULL,
         model         TEXT    NOT NULL,
         fields_json   TEXT    NOT NULL,
         input_tokens  INTEGER NOT NULL,
         output_tokens INTEGER NOT NULL,
         cost_usd      REAL,
         latency_ms    INTEGER NOT NULL,
         created_at    INTEGER NOT NULL,
         PRIMARY KEY (sha256, version)
       )`,
      `CREATE TABLE fields (
         sha256     TEXT    NOT NULL,
         name       TEXT    NOT NULL,
         value_json TEXT    NOT NULL,
         source     TEXT    NOT NULL CHECK (source IN ('machine', 'user')),
         confidence REAL    NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (sha256, name)
       )`,
    ],
  },
  {
    // Device pairing (ADR 0008). Codes and tokens are kept only as SHA-256 hashes.
    id: 7,
    name: 'devices',
    statements: [
      `CREATE TABLE devices (
         id         TEXT    PRIMARY KEY,
         name       TEXT    NOT NULL,
         token_hash TEXT    NOT NULL UNIQUE,
         created_at INTEGER NOT NULL,
         last_seen  INTEGER,
         revoked_at INTEGER
       )`,
      `CREATE TABLE pairing_codes (
         code_hash  TEXT    PRIMARY KEY,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         used_at    INTEGER
       )`,
      // Which phone first delivered each document. Null for the admin token, and for
      // everything stored before pairing existed.
      `ALTER TABLE documents ADD COLUMN device_id TEXT`,
    ],
  },
  {
    // Notes people write on a document. Searchable along with its text, and kept
    // apart from `fields`: a note is something said about a document, not a detail
    // of it that extraction could ever propose.
    id: 8,
    name: 'notes',
    statements: [
      `CREATE TABLE notes (
         id         INTEGER PRIMARY KEY,
         sha256     TEXT    NOT NULL,
         text       TEXT    NOT NULL,
         device_id  TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX notes_by_document ON notes (sha256, created_at)`,
    ],
  },
  {
    // The trash. Deleting a document only sets this; it is removed for good later,
    // so a mistaken delete is a restore away rather than gone.
    id: 9,
    name: 'trash',
    statements: [
      `ALTER TABLE documents ADD COLUMN trashed_at INTEGER`,
      `CREATE INDEX documents_by_trashed ON documents (trashed_at)`,
    ],
  },
  {
    // Custom fields: definitions people make, and each document's values of them.
    // Apart from `fields`, which holds what extraction reads and a person corrects;
    // these exist only because someone chose to track them.
    id: 10,
    name: 'custom_fields',
    statements: [
      `CREATE TABLE custom_fields (
         id           INTEGER PRIMARY KEY,
         name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
         data_type    TEXT    NOT NULL,
         options_json TEXT    NOT NULL DEFAULT '[]',
         created_at   INTEGER NOT NULL
       )`,
      `CREATE TABLE custom_field_values (
         sha256     TEXT    NOT NULL,
         field_id   INTEGER NOT NULL,
         value_json TEXT    NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (sha256, field_id)
       )`,
      `CREATE INDEX custom_field_values_by_field ON custom_field_values (field_id)`,
    ],
  },
  {
    // Amounts read before minor units followed ISO 4217 were stored as if every
    // currency but JPY and KRW had cents. Rescale those whose ISO unit differs, in
    // both the current totals and every recorded extraction run. The lists are
    // written out, not read from `minorDigits`, so this migration means the same
    // thing however that table changes later.
    id: 11,
    name: 'iso_minor_units',
    statements: [
      rescaleMoney('fields', 'value_json', '$', `name = 'total'`),
      rescaleMoney(
        'extractions',
        'fields_json',
        '$.total.value',
        `json_extract(fields_json, '$.total') IS NOT NULL`,
      ),
    ],
  },
  {
    // A colour for each tag, chosen by a person. Null means none was chosen.
    id: 12,
    name: 'label_colours',
    statements: ['ALTER TABLE names ADD COLUMN colour TEXT'],
  },
  {
    // How each label finds its own documents, and which tags mark a new document as
    // not yet looked at. Every existing label starts out matching nothing.
    id: 13,
    name: 'label_matching',
    statements: [
      `ALTER TABLE names ADD COLUMN match_algorithm TEXT NOT NULL DEFAULT 'none'`,
      `ALTER TABLE names ADD COLUMN match_pattern TEXT NOT NULL DEFAULT ''`,
      'ALTER TABLE names ADD COLUMN match_case INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE names ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    // Rules and the inbox tag are for documents that arrive from now on. Count the
    // matching step (`steps/match.ts`, version 1) as done for everything already
    // here, so an inbox tag made while a backlog drains is not put on old documents.
    // Applying rules to those is a separate, deliberate request.
    id: 14,
    name: 'match_existing_done',
    statements: [
      `INSERT OR IGNORE INTO jobs (sha256, step, version, state, attempts, created_at)
       SELECT sha256, 'match', 1, 'done', 0, received_at FROM documents`,
    ],
  },
  {
    // Filters kept under a name. The filter is the protocol's DocumentFilter as JSON.
    id: 15,
    name: 'saved_views',
    statements: [
      `CREATE TABLE saved_views (
         id           INTEGER PRIMARY KEY,
         name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
         filter_json  TEXT    NOT NULL,
         on_dashboard INTEGER NOT NULL DEFAULT 0,
         position     INTEGER NOT NULL DEFAULT 0,
         created_at   INTEGER NOT NULL
       )`,
    ],
  },
  {
    // The date on the document itself, and the archive serial number that ties it to
    // its paper original. A serial number belongs to one document at most.
    id: 16,
    name: 'created_and_asn',
    statements: [
      'ALTER TABLE documents ADD COLUMN created TEXT',
      'ALTER TABLE documents ADD COLUMN asn INTEGER',
      'CREATE UNIQUE INDEX documents_by_asn ON documents (asn) WHERE asn IS NOT NULL',
    ],
  },
  {
    // Links that open one document without a token. The slug is the secret.
    id: 17,
    name: 'share_links',
    statements: [
      `CREATE TABLE share_links (
         id         INTEGER PRIMARY KEY,
         slug       TEXT    NOT NULL UNIQUE,
         sha256     TEXT    NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER
       )`,
      'CREATE INDEX share_links_by_document ON share_links (sha256)',
    ],
  },
  {
    // Workflows: when, for which documents, and what to do. Conditions and actions
    // are the protocol's WorkflowConditions and WorkflowActions as JSON.
    id: 18,
    name: 'workflows',
    statements: [
      `CREATE TABLE workflows (
         id              INTEGER PRIMARY KEY,
         name            TEXT    NOT NULL,
         enabled         INTEGER NOT NULL,
         trigger_kind    TEXT    NOT NULL,
         conditions_json TEXT    NOT NULL,
         actions_json    TEXT    NOT NULL,
         position        INTEGER NOT NULL,
         created_at      INTEGER NOT NULL
       )`,
    ],
  },
  {
    // People who sign in, and their sessions. Passwords and tokens are kept only as hashes.
    id: 19,
    name: 'users',
    statements: [
      `CREATE TABLE users (
         id            INTEGER PRIMARY KEY,
         username      TEXT    NOT NULL UNIQUE,
         password_hash TEXT    NOT NULL,
         role          TEXT    NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
         created_at    INTEGER NOT NULL,
         disabled_at   INTEGER,
         last_sign_in  INTEGER
       )`,
      `CREATE TABLE sessions (
         token_hash TEXT    PRIMARY KEY,
         user_id    INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    // Who changed what, through the API: every change that succeeded.
    id: 20,
    name: 'audit_log',
    statements: [
      `CREATE TABLE audit_log (
         id         INTEGER PRIMARY KEY,
         at         INTEGER NOT NULL,
         actor_kind TEXT    NOT NULL CHECK (actor_kind IN ('admin', 'user', 'device')),
         actor_id   TEXT,
         actor_name TEXT,
         method     TEXT    NOT NULL,
         path       TEXT    NOT NULL,
         sha256     TEXT,
         status     INTEGER NOT NULL
       )`,
      'CREATE INDEX audit_log_by_document ON audit_log (sha256, at)',
    ],
  },
  {
    // Earlier files of an edited document. The document itself moves to each new
    // file's hash; the file it had stays on disk under its own, listed here.
    id: 21,
    name: 'document_versions',
    statements: [
      `CREATE TABLE document_versions (
         document_sha256 TEXT    NOT NULL,
         version_sha256  TEXT    NOT NULL,
         bytes           INTEGER NOT NULL,
         page_count      INTEGER,
         created_at      INTEGER NOT NULL,
         PRIMARY KEY (document_sha256, version_sha256)
       )`,
    ],
  },
  {
    // Settings an admin changed from the web app. Those not here come from the
    // environment, or the built-in default.
    id: 22,
    name: 'settings',
    statements: [
      `CREATE TABLE settings (
         key        TEXT    PRIMARY KEY,
         value_json TEXT    NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    ],
  },
];

/** Applies every migration not yet recorded, in id order. Returns the ids it applied. */
export async function migrate(
  driver: SqlDriver,
  now: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<readonly number[]> {
  assertOrdered(migrations);
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  const done = new Set(
    (await driver.all<{ id: number }>('SELECT id FROM schema_migrations')).map((row) => row.id),
  );

  const applied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    await driver.transaction(async () => {
      for (const statement of migration.statements) await driver.exec(statement);
      await driver.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        now,
      ]);
    });
    applied.push(migration.id);
  }
  return applied;
}

/**
 * Ids must be unique and increasing. A duplicate would be silently skipped as
 * "already applied" on every database that has the first one, which is the kind of
 * mistake that only shows up on somebody else's server.
 */
function assertOrdered(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.id <= migrations[i - 1]!.id) {
      throw new Error(
        `migration ids must increase: ${String(migrations[i]!.id)} after ${String(migrations[i - 1]!.id)}`,
      );
    }
  }
}
