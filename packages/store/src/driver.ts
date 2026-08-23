/**
 * The narrow SQL surface the log needs.
 *
 * Declared here so the same schema and the same queries run against `expo-sqlite`
 * on device and `node:sqlite` in tests. The SQL that ships is therefore the SQL
 * that is tested, rather than a mock of it.
 */

export type SqlValue = string | number | null;

export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  /** Must roll back entirely if the callback throws. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
}
