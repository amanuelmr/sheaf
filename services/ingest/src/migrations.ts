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
