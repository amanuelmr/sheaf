import { randomBytes } from 'node:crypto';
import { SHARE_SLUG_PATTERN, type ShareLink } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { Storage } from './storage.ts';

const DAY_MS = 86_400_000;

interface LinkRow {
  id: number;
  slug: string;
  sha256: string;
  created_at: number;
  expires_at: number | null;
}

/**
 * Links that open one document for anyone who holds them.
 *
 * The slug is the whole secret: 192 random bits, so it cannot be guessed, and it
 * is kept as it is because the person who made it may want to copy it again. A
 * link stops working when it expires, is revoked, or its document goes to the trash.
 */
export class ShareLinks {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;

  constructor(driver: SqlDriver, storage: Storage) {
    this.#driver = driver;
    this.#storage = storage;
  }

  async list(sha256: string): Promise<readonly ShareLink[]> {
    const rows = await this.#driver.all<LinkRow>(
      'SELECT * FROM share_links WHERE sha256 = ? ORDER BY created_at DESC, id DESC',
      [sha256],
    );
    return rows.map(toLink);
  }

  /** Null when the document is not here, or is in the trash. */
  async create(sha256: string, days: number | null, now: number): Promise<ShareLink | null> {
    const record = await this.#storage.record(sha256);
    if (record === null || record.trashedAt !== undefined) return null;
    const slug = randomBytes(24).toString('base64url');
    await this.#driver.run(
      'INSERT INTO share_links (slug, sha256, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [slug, sha256, now, days === null ? null : now + days * DAY_MS],
    );
    const rows = await this.#driver.all<LinkRow>('SELECT * FROM share_links WHERE slug = ?', [
      slug,
    ]);
    return toLink(rows[0]!);
  }

  async revoke(id: number): Promise<boolean> {
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM share_links WHERE id = ?',
      [id],
    );
    if ((rows[0]?.n ?? 0) === 0) return false;
    await this.#driver.run('DELETE FROM share_links WHERE id = ?', [id]);
    return true;
  }

  /** The document a slug opens right now, or null. */
  async resolve(slug: string, now: number): Promise<string | null> {
    if (!SHARE_SLUG_PATTERN.test(slug)) return null;
    const rows = await this.#driver.all<LinkRow>(
      `SELECT l.* FROM share_links l JOIN documents d ON d.sha256 = l.sha256
        WHERE l.slug = ? AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND d.trashed_at IS NULL`,
      [slug, now],
    );
    return rows[0]?.sha256 ?? null;
  }
}

function toLink(row: LinkRow): ShareLink {
  return {
    id: row.id,
    sha256: row.sha256,
    slug: row.slug,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
