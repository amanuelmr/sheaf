import type { AccuracyResponse, FieldAccuracy, Suggestions } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

/** How many of the latest judgements each field's share is worked out over. */
export const ACCURACY_WINDOW = 50;

/** The fields a machine suggests and a person then keeps or corrects. */
const JUDGED = ['title', 'date', 'correspondent', 'documentType', 'tags'] as const;

const fold = (value: unknown): string =>
  Array.isArray(value)
    ? JSON.stringify(value.map((v) => JSON.stringify(v).toLowerCase()).sort())
    : typeof value === 'string'
      ? value.trim().toLowerCase()
      : JSON.stringify(value ?? null);

/**
 * How often each suggestion was right, judged by what people did with it: a field
 * a person saved as it was suggested counts as right, one they changed as wrong.
 * Only fields a person actually set are judged, so a document filed by title alone
 * says nothing about its date.
 */
export async function accuracy(
  driver: SqlDriver,
  window = ACCURACY_WINDOW,
): Promise<AccuracyResponse> {
  const rows = await driver.all<{ name: string; value_json: string; suggestions_json: string }>(
    `SELECT f.name, f.value_json, d.suggestions_json
       FROM fields f JOIN documents d ON d.sha256 = f.sha256
      WHERE f.source = 'user' AND d.suggestions_json IS NOT NULL
        AND d.suggestions_json <> '{}' AND d.trashed_at IS NULL
      ORDER BY f.updated_at DESC, f.sha256
      LIMIT ?`,
    [window * JUDGED.length * 20],
  );
  const tally = new Map<string, { right: number; judged: number }>(
    JUDGED.map((name) => [name, { right: 0, judged: 0 }]),
  );
  for (const row of rows) {
    const counts = tally.get(row.name);
    if (counts === undefined || counts.judged >= window) continue;
    const suggested = (JSON.parse(row.suggestions_json) as Record<string, unknown>)[row.name] as
      Suggestions[keyof Suggestions] | undefined;
    if (suggested === undefined) continue;
    counts.judged++;
    if (fold(suggested) === fold(JSON.parse(row.value_json))) counts.right++;
  }
  const fields: FieldAccuracy[] = JUDGED.map((field) => ({ field, ...tally.get(field)! }));
  return { window, fields };
}
