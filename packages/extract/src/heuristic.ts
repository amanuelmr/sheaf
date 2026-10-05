/**
 * The extractor that sends nothing anywhere, and the default (ADR 0010).
 *
 * Plain rules over the text: the date nearest a word like "date" or "invoice", the
 * amount on the last line that says "total", the sender from the first lines. The
 * eval measures it against the language models, so "is AI worth it here" has an
 * answer in numbers.
 */
import { ok } from '@sheaf/http';
import { NO_USAGE, type Extractor, type ExtractionInput } from './extractor.ts';
import { findDates, matchVocabulary, parseMoney } from './normalise.ts';
import type { ExtractedFields, Field, Money } from './schema.ts';

const VERSION = 1;

const DATE_LABEL = /\b(date|dated|datum|fecha|invoice|issued|bill|receipt|tarikh)\b/i;
/** Lines naming the final amount. "Subtotal", tax and change lines are not it. */
const TOTAL_LABEL =
  /\b(grand\s+total|total|amount\s+due|balance\s+due|to\s+pay|gesamt|summe|net\s+amount)\b/i;
const NOT_TOTAL = /\b(sub\s*-?\s*total|tax|vat|gst|rounding|change|discount|saving|tip)\b/i;
/** An amount with a decimal part, optionally with a currency: never a phone number. */
const AMOUNT =
  /(?:(?:[€£$¥₹]|\b(?:RM|EUR|USD|GBP|CHF|MYR|INR|ETB)\b)\s*)?-?\d{1,3}(?:[.,' ]?\d{3})*[.,]\d{2}\b(?:\s*(?:€|EUR))?/g;

const TYPES: readonly (readonly [RegExp, string])[] = [
  [/\b(invoice|rechnung|facture|tax\s+invoice)\b/i, 'Invoice'],
  [/\b(receipt|kassenbon|quittung|reçu|cash\s+sale)\b/i, 'Receipt'],
  [/\b(statement|kontoauszug)\b/i, 'Statement'],
  [/\b(contract|agreement|vertrag)\b/i, 'Contract'],
  [/\b(bill|utility|electricity|water\s+charges)\b/i, 'Bill'],
];

export function heuristicExtractor(): Extractor {
  return {
    name: 'heuristic',
    version: VERSION,
    extract: (input) =>
      Promise.resolve(
        ok({ fields: extract(input), usage: NO_USAGE, model: `heuristic-${String(VERSION)}` }),
      ),
  };
}

function extract(input: ExtractionInput): ExtractedFields {
  const lines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const date = findDate(lines, input);
  const total = findTotal(lines, input.defaultCurrency);
  const correspondent = findCorrespondent(lines, input);
  const documentType = findType(input);
  const title = [correspondent?.value, documentType?.value, date?.value].filter(Boolean).join(' ');

  return {
    ...(date === null ? {} : { date }),
    ...(total === null ? {} : { total }),
    ...(correspondent === null ? {} : { correspondent }),
    ...(documentType === null ? {} : { documentType }),
    ...(title === ''
      ? {}
      : { title: { value: title, confidence: Math.min(correspondent?.confidence ?? 0.3, 0.6) } }),
  };
}

function findDate(lines: readonly string[], input: ExtractionInput): Field<string> | null {
  const options = { order: input.dateOrder, today: input.today };
  let fallback: string | null = null;
  for (const line of lines) {
    for (const { iso } of findDates(line, options)) {
      // A date after today is a due date or a misreading, not when this was issued.
      if (iso > input.today) continue;
      if (DATE_LABEL.test(line)) return { value: iso, confidence: 0.9 };
      if (fallback === null || iso > fallback) fallback = iso;
    }
  }
  return fallback === null ? null : { value: fallback, confidence: 0.6 };
}

function findTotal(lines: readonly string[], currency: string): Field<Money> | null {
  const amounts = (line: string): Money[] =>
    (line.match(AMOUNT) ?? [])
      .map((raw) => parseMoney(raw, currency))
      .filter((money): money is Money => money !== null);

  // The last labelled line wins: receipts often print a total before discounts and
  // again after them, and the later one is what was paid.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!TOTAL_LABEL.test(line) || NOT_TOTAL.test(line)) continue;
    // The amount may be printed on the line below the label.
    const found = amounts(line).at(-1) ?? amounts(lines[i + 1] ?? '').at(0);
    if (found !== undefined) return { value: found, confidence: 0.85 };
  }

  const all = lines.flatMap(amounts).filter((money) => money.minor > 0);
  if (all.length === 0) return null;
  const largest = all.reduce((a, b) => (b.minor > a.minor ? b : a));
  return { value: largest, confidence: 0.4 };
}

function findCorrespondent(lines: readonly string[], input: ExtractionInput): Field<string> | null {
  const candidates = lines
    .slice(0, 6)
    .filter((line) => (line.match(/\p{L}/gu) ?? []).length >= 3)
    .filter((line) => !TOTAL_LABEL.test(line) && !DATE_LABEL.test(line));

  for (const line of candidates) {
    const known = matchVocabulary(line, input.vocabulary.correspondents);
    if (known !== null) return { value: known, confidence: 0.85 };
  }
  const first = candidates[0];
  return first === undefined ? null : { value: first.slice(0, 80), confidence: 0.5 };
}

function findType(input: ExtractionInput): Field<string> | null {
  for (const [pattern, type] of TYPES) {
    if (!pattern.test(input.text)) continue;
    // Prefer the archive's own spelling, e.g. "Receipts" where it already has one.
    const known = matchVocabulary(type, input.vocabulary.documentTypes, 0.75);
    return { value: known ?? type, confidence: 0.7 };
  }
  return null;
}
