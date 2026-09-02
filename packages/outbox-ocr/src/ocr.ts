import type { SqlDriver } from '@sheaf/store';

interface Row {
  doc_id: string;
  text: string;
  extracted_at: number;
}

/**
 * Save the text recognised for a document. An upsert -- a capture is only ever
 * OCR'd once, but re-running it (a retry, a future re-extraction) just refreshes
 * what is there rather than erroring or duplicating.
 */
export async function save(
  driver: SqlDriver,
  docId: string,
  text: string,
  now: number,
): Promise<void> {
  await driver.run(
    `INSERT INTO outbox_ocr (doc_id, text, extracted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       text = excluded.text,
       extracted_at = excluded.extracted_at`,
    [docId, text, now],
  );
}

export async function get(driver: SqlDriver, docId: string): Promise<string | null> {
  const rows = await driver.all<Row>('SELECT * FROM outbox_ocr WHERE doc_id = ?', [docId]);
  return rows[0]?.text ?? null;
}

/**
 * Called once a document is released -- synced and no longer kept locally.
 * Keeping its text past that point would let a search here return a stale hit
 * for a document that isn't in the outbox any more and is now properly
 * searchable through the archive instead.
 */
export async function remove(driver: SqlDriver, docId: string): Promise<void> {
  await driver.run('DELETE FROM outbox_ocr WHERE doc_id = ?', [docId]);
}

/**
 * Every document whose recognised text contains this substring, most recently
 * extracted first. Returns ids only -- the caller already holds the full
 * `OutboxRow` for each document in memory, so there is nothing else worth
 * duplicating into this table.
 *
 * Not FTS5, matching `@sheaf/archive-cache`'s own reasoning: `expo-sqlite`'s
 * FTS5 support has a documented history of regressing silently between SDK
 * releases, and an outbox bounded to however many documents are mid-flight has
 * no need of a ranked index to answer well under a frame.
 */
export async function search(
  driver: SqlDriver,
  text: string,
  limit = 100,
): Promise<readonly string[]> {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const pattern = `%${trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await driver.all<Row>(
    `SELECT * FROM outbox_ocr WHERE text LIKE ? ESCAPE '\\' ORDER BY extracted_at DESC LIMIT ?`,
    [pattern, limit],
  );
  return rows.map((row) => row.doc_id);
}
