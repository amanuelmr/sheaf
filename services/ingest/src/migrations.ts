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
