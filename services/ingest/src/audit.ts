import type { AuditEntry } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

export type Actor =
  | { readonly kind: 'admin' }
  | { readonly kind: 'user'; readonly id: number; readonly name: string }
  | { readonly kind: 'device'; readonly id: string };

interface AuditRow {
  id: number;
  at: number;
  actor_kind: Actor['kind'];
  actor_name: string | null;
  device_name: string | null;
  method: string;
  path: string;
  sha256: string | null;
}

const DOCUMENT = /\/documents\/([0-9a-f]{64})(?:\/([a-z-]+))?/;

/** Every change that succeeded through the API, and who made it. */
export class AuditLog {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  async record(
    actor: Actor,
    method: string,
    path: string,
    status: number,
    at: number,
  ): Promise<void> {
    await this.#driver.run(
      `INSERT INTO audit_log (at, actor_kind, actor_id, actor_name, method, path, sha256, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        at,
        actor.kind,
        actor.kind === 'admin' ? null : String(actor.id),
        actor.kind === 'user' ? actor.name : null,
        method,
        path,
        DOCUMENT.exec(path)?.[1] ?? null,
        status,
      ],
    );
  }

  /** Newest first; `sha256` for one document's, `before` an id to page back from. */
  async list(options: {
    limit: number;
    before?: number;
    sha256?: string;
  }): Promise<readonly AuditEntry[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.before !== undefined) {
      where.push('a.id < ?');
      params.push(options.before);
    }
    if (options.sha256 !== undefined) {
      where.push('a.sha256 = ?');
      params.push(options.sha256);
    }
    const rows = await this.#driver.all<AuditRow>(
      `SELECT a.id, a.at, a.actor_kind, a.actor_name, d.name AS device_name, a.method, a.path, a.sha256
         FROM audit_log a
         LEFT JOIN devices d ON a.actor_kind = 'device' AND d.id = a.actor_id
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY a.id DESC LIMIT ?`,
      [...params, options.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      who:
        row.actor_kind === 'admin'
          ? 'admin token'
          : row.actor_kind === 'user'
            ? (row.actor_name ?? 'a user')
            : (row.device_name ?? 'a phone'),
      what: describe(row.method, row.path),
      sha256: row.sha256,
    }));
  }
}

/** A change in a few words, from the route it went to. */
export function describe(method: string, path: string): string {
  const document = DOCUMENT.exec(path);
  if (document !== null) {
    const part = document[2];
    if (part === undefined) {
      if (method === 'PUT') return 'Uploaded the document';
      if (method === 'PATCH') return 'Edited the details';
      if (method === 'DELETE') return 'Moved it to the trash';
    }
    if (part === 'text') return 'Sent its text';
    if (part === 'notes') return 'Added a note';
    if (part === 'custom-fields') return 'Set its custom fields';
    if (part === 'share-links') return 'Made a share link';
    if (part === 'pages') return 'Edited its pages';
    if (part === 'split') return 'Split it into new documents';
    if (part === 'stamp') return 'Stamped it';
    if (part === 'versions') return 'Restored an earlier version';
    if (part === 'permissions') return 'Changed who may see it';
  }
  if (/\/notes\/\d+$/.test(path)) return 'Deleted a note';
  const area = path.replace(/^\/v1\//, '').split('/')[0] ?? path;
  const verb =
    { POST: 'Added to', PATCH: 'Changed', PUT: 'Replaced in', DELETE: 'Removed from' }[method] ??
    method;
  return `${verb} ${area.replace(/-/g, ' ')}`;
}
