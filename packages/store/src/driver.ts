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
  /**
   * Must roll back entirely if the callback throws. The work is handed the driver
   * to query through; where a runtime cannot tell a transaction's own queries from
   * others (the phone), only queries made through it are part of the transaction.
   */
  transaction<T>(work: (tx: SqlDriver) => Promise<T>): Promise<T>;
}
