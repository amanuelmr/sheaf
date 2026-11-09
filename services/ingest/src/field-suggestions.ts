import type { CustomFieldData, CustomFieldSuggestion, CustomFieldType } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { visibleTo } from './storage.ts';

/** How many documents with values the vote looks at, newest first. */
const TRAINING_DOCUMENTS = 500;
/** How many of the most alike documents vote. */
const NEIGHBOURS = 7;
/** Below this, a document is too unlike to vote at all. */
const MIN_LIKENESS = 0.12;
/** A value must win this share of the vote… */
const MIN_SHARE = 0.6;
/** …and be on at least this many voting documents: one alike document is a coincidence. */
const MIN_VOTES = 2;
/** Words read from each document's text. */
const MAX_WORDS = 1_500;

/**
 * Types a value of which recurs across documents: a category, a yes or no, a
 * policy number on every letter from one insurer. Amounts and dates are each
 * document's own and are left to extraction; links point at particular documents.
 */
const LEARNABLE: ReadonlySet<CustomFieldType> = new Set([
  'select',
  'boolean',
  'text',
  'url',
  'integer',
]);

interface Example {
  readonly sha256: string;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly words: ReadonlySet<string>;
}

export function wordsOf(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}]{2,}/gu)) {
    words.add(match[0]);
    if (words.size >= MAX_WORDS) break;
  }
  return words;
}

/**
 * How alike two documents are, from 0 to 1: the share of words they have in
 * common, raised for the same correspondent or type, the strongest hints a
 * document has about how it is filed.
 */
export function likeness(a: Example, b: Example): number {
  let shared = 0;
  const [small, large] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
  for (const word of small) if (large.has(word)) shared++;
  const union = a.words.size + b.words.size - shared;
  const words = union === 0 ? 0 : shared / union;
  const sameFrom = a.correspondent !== null && a.correspondent === b.correspondent ? 0.35 : 0;
  const sameType = a.documentType !== null && a.documentType === b.documentType ? 0.15 : 0;
  return Math.min(1, words + sameFrom + sameType);
}

/**
 * Values for a document's custom fields, learned from the documents most like it
 * that have them: each of the most alike votes for its own value, weighted by how
 * alike it is, and a value is suggested only when it wins clearly. Fields the
 * document already has a value for are left out. Nothing is written: a person
 * takes a suggestion or not.
 */
export async function suggestFieldValues(
  driver: SqlDriver,
  sha256: string,
  viewer: number | null = null,
): Promise<readonly CustomFieldSuggestion[]> {
  const subject = await examplesOf(driver, `d.sha256 = ?`, [sha256]);
  const target = subject[0];
  if (target === undefined) return [];

  const fields = await driver.all<{ id: number; data_type: CustomFieldType; options: string }>(
    'SELECT id, data_type, options_json AS options FROM custom_fields',
  );
  const filled = new Set(
    (
      await driver.all<{ field_id: number }>(
        `SELECT field_id FROM custom_field_values WHERE sha256 = ? AND value_json <> 'null'`,
        [sha256],
      )
    ).map((row) => row.field_id),
  );
  const open = fields.filter((f) => LEARNABLE.has(f.data_type) && !filled.has(f.id));
  if (open.length === 0) return [];

  // What a person cannot see must not leak into what they are told.
  const visible = visibleTo(viewer);
  const examples = await examplesOf(
    driver,
    `d.sha256 <> ? AND d.trashed_at IS NULL AND ${visible.sql}
       AND d.sha256 IN (SELECT sha256 FROM custom_field_values WHERE value_json <> 'null')
     ORDER BY d.received_at DESC LIMIT ${String(TRAINING_DOCUMENTS)}`,
    [sha256, ...visible.params],
  );
  const near = examples
    .map((example) => ({ example, score: likeness(target, example) }))
    .filter((n) => n.score >= MIN_LIKENESS)
    .sort((a, b) => b.score - a.score);
  if (near.length === 0) return [];

  const values = await driver.all<{ sha256: string; field_id: number; value_json: string }>(
    `SELECT sha256, field_id, value_json FROM custom_field_values
      WHERE value_json <> 'null' AND sha256 IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(near.map((n) => n.example.sha256))],
  );
  const byDocument = new Map<string, Map<number, string>>();
  for (const row of values) {
    const own = byDocument.get(row.sha256) ?? new Map<number, string>();
    own.set(row.field_id, row.value_json);
    byDocument.set(row.sha256, own);
  }

  const suggestions: CustomFieldSuggestion[] = [];
  for (const field of open) {
    const voters = near
      .filter((n) => byDocument.get(n.example.sha256)?.has(field.id) === true)
      .slice(0, NEIGHBOURS);
    const tally = new Map<string, { weight: number; votes: number }>();
    let total = 0;
    for (const { example, score } of voters) {
      const value = byDocument.get(example.sha256)!.get(field.id)!;
      const seen = tally.get(value) ?? { weight: 0, votes: 0 };
      tally.set(value, { weight: seen.weight + score, votes: seen.votes + 1 });
      total += score;
    }
    const best = [...tally].sort((a, b) => b[1].weight - a[1].weight)[0];
    if (best === undefined) continue;
    const [json, { weight, votes }] = best;
    const share = weight / total;
    if (votes < MIN_VOTES || share < MIN_SHARE) continue;
    const value = JSON.parse(json) as CustomFieldData;
    // A choice since taken off the list is not offered again.
    if (
      field.data_type === 'select' &&
      !(JSON.parse(field.options) as string[]).includes(value as string)
    ) {
      continue;
    }
    suggestions.push({
      field: field.id,
      value,
      confidence: Math.round(share * 100) / 100,
      basedOn: votes,
    });
  }
  return suggestions;
}

async function examplesOf(
  driver: SqlDriver,
  where: string,
  params: readonly (string | number)[],
): Promise<Example[]> {
  const rows = await driver.all<{
    sha256: string;
    correspondent: string | null;
    document_type: string | null;
    text: string | null;
  }>(
    `SELECT d.sha256, d.correspondent, d.document_type,
            (SELECT substr(group_concat(t.text, ' '), 1, 20000)
               FROM document_text t WHERE t.sha256 = d.sha256) AS text
       FROM documents d WHERE ${where}`,
    [...params],
  );
  return rows.map((row) => ({
    sha256: row.sha256,
    correspondent: row.correspondent,
    documentType: row.document_type,
    words: wordsOf(row.text ?? ''),
  }));
}
