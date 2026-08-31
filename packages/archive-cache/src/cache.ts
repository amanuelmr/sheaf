import type { ArchiveDocument } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { CachedDocument } from './types.ts';

interface Row {
  id: number;
  title: string;
  correspondent: string | null;
  document_type: string | null;
  tags: string;
  created: string;
  content_snippet: string | null;
  thumbnail_path: string | null;
  starred: number;
  cached_at: number;
}

function toCached(row: Row): CachedDocument {
  return {
    id: row.id,
    title: row.title,
    correspondent: row.correspondent,
    documentType: row.document_type,
    tags: JSON.parse(row.tags) as string[],
    created: row.created,
    contentSnippet: row.content_snippet,
    thumbnailPath: row.thumbnail_path,
    starred: row.starred === 1,
    cachedAt: row.cached_at,
  };
}

/**
 * Save a document that was actually opened. An upsert -- opening the same
 * document twice just refreshes when it was last seen -- and one that never
 * touches `starred` on its own: viewing something again must never silently
 * star it, or clear a star someone set on purpose.
 */
export async function save(
  driver: SqlDriver,
  document: ArchiveDocument,
  thumbnailPath: string | null,
  now: number,
): Promise<void> {
  await driver.run(
    `INSERT INTO archive_cache
       (id, title, correspondent, document_type, tags, created, content_snippet, thumbnail_path, starred, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       correspondent = excluded.correspondent,
       document_type = excluded.document_type,
       tags = excluded.tags,
       created = excluded.created,
       content_snippet = excluded.content_snippet,
       thumbnail_path = excluded.thumbnail_path,
       cached_at = excluded.cached_at`,
    [
      document.id,
      document.title,
      document.correspondent,
      document.documentType,
      JSON.stringify(document.tags),
      document.created,
      document.contentSnippet,
      thumbnailPath,
      now,
    ],
  );
}

export async function setStarred(driver: SqlDriver, id: number, starred: boolean): Promise<void> {
  await driver.run('UPDATE archive_cache SET starred = ? WHERE id = ?', [starred ? 1 : 0, id]);
}

export async function get(driver: SqlDriver, id: number): Promise<CachedDocument | null> {
  const rows = await driver.all<Row>('SELECT * FROM archive_cache WHERE id = ?', [id]);
  return rows[0] === undefined ? null : toCached(rows[0]);
}

/**
 * Everything cached, newest-viewed first, optionally narrowed by a plain
 * substring match across every field someone might search by.
 *
 * Not FTS5: `expo-sqlite`'s FTS5 support has a documented history of regressing
 * silently between SDK releases, including an Android-only "no such module"
 * failure. A cache bounded to a couple of hundred rows has no need of a ranked
 * index to answer well under a frame, and `LIKE` is guaranteed to exist wherever
 * SQLite does.
 */
export async function search(
  driver: SqlDriver,
  text: string,
  limit = 100,
): Promise<readonly CachedDocument[]> {
  const trimmed = text.trim();
  if (trimmed === '') {
    const rows = await driver.all<Row>(
      'SELECT * FROM archive_cache ORDER BY starred DESC, cached_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toCached);
  }
  const pattern = `%${trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await driver.all<Row>(
    `SELECT * FROM archive_cache
      WHERE (title || ' ' || COALESCE(correspondent, '') || ' ' || COALESCE(document_type, '')
             || ' ' || tags || ' ' || COALESCE(content_snippet, '')) LIKE ? ESCAPE '\\'
      ORDER BY starred DESC, cached_at DESC
      LIMIT ?`,
    [pattern, limit],
  );
  return rows.map(toCached);
}

/**
 * Keep an unstarred cache from growing without bound. Starred documents are
 * exempt entirely -- they were kept on purpose, and eviction should never be why
 * one silently disappears. Returns the thumbnail paths of whatever was removed,
 * so the caller can delete those files: this module has no filesystem access of
 * its own, only SQL.
 */
export async function evictUnstarred(driver: SqlDriver, keep: number): Promise<readonly string[]> {
  const overflow = await driver.all<{ thumbnail_path: string | null }>(
    `SELECT thumbnail_path FROM archive_cache
      WHERE starred = 0
      ORDER BY cached_at DESC
      LIMIT -1 OFFSET ?`,
    [keep],
  );
  if (overflow.length === 0) return [];
  await driver.run(
    `DELETE FROM archive_cache WHERE id IN (
       SELECT id FROM archive_cache WHERE starred = 0 ORDER BY cached_at DESC LIMIT -1 OFFSET ?
     )`,
    [keep],
  );
  return overflow.map((row) => row.thumbnail_path).filter((path): path is string => path !== null);
}
