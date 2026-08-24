import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentPatch, DocumentRecord, PutOutcome } from '@sheaf/protocol';
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

interface Row {
  sha256: string;
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
  private constructor(
    private readonly driver: SqlDriver,
    private readonly objectsDir: string,
  ) {}

  static async open(options: StorageOptions): Promise<Storage> {
    for (const statement of SCHEMA) await options.driver.exec(statement);
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
    mkdirSync(join(this.objectsDir, sha256.slice(0, 2)), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);

    await this.driver.run(
      `INSERT INTO documents (sha256, bytes, page_count, received_at, tags)
       VALUES (?, ?, ?, ?, '[]')
       ON CONFLICT(sha256) DO NOTHING`,
      [sha256, bytes.length, pageCount, now],
    );
    return 'stored';
  }

  async has(sha256: string): Promise<boolean> {
    const rows = await this.driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM documents WHERE sha256 = ?',
      [sha256],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  async record(sha256: string): Promise<DocumentRecord | null> {
    const rows = await this.driver.all<Row>('SELECT * FROM documents WHERE sha256 = ?', [sha256]);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  bytes(sha256: string): Uint8Array | null {
    const path = this.pathFor(sha256);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  async list(limit = 200): Promise<readonly DocumentRecord[]> {
    const rows = await this.driver.all<Row>(
      'SELECT * FROM documents ORDER BY received_at DESC, sha256 ASC LIMIT ?',
      [limit],
    );
    return rows.map(toRecord);
  }

  async count(): Promise<number> {
    const rows = await this.driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
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
      await this.driver.run(`UPDATE documents SET ${sets.join(', ')} WHERE sha256 = ?`, values);
    }
    return this.record(sha256);
  }

  private pathFor(sha256: string): string {
    // Two-character fan-out keeps any one directory from growing without bound.
    return join(this.objectsDir, sha256.slice(0, 2), `${sha256}.pdf`);
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
  };
}
