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

const VERSION = 2;

const DATE_LABEL = /\b(date|dated|datum|fecha|invoice|issued|bill|receipt|tarikh)\b/i;
/** Lines naming the final amount. "Subtotal", tax and change lines are not it. */
const TOTAL_LABEL =
  /\b(grand\s+total|total|amount\s+due|balance\s+due|to\s+pay|gesamt|summe|net\s+amount)\b/i;
const NOT_TOTAL =
  /\b(sub\s*-?\s*total|tax|vat|gst|rounding|change|discount|saving|tip|qty|items?)\b/i;
/** "TOTAL INCL. GST" names a tax but is the total all the same. */
const INCLUSIVE = /\b(incl\.?|inclusive|with|after)\b/i;
/** Where a receipt's tax breakdown starts; any "total" after it totals the tax. */
const TAX_TABLE = /\b(gst|tax)\s+(summary|analysis)\b|\btax\s*code\b|\btax\s*\(rm\)/i;
const CASH = /\b(cash|tender(ed)?|payment)\b/i;
const CHANGE = /\bchange\b/i;
/** How many lines below its label an amount may be printed: OCR often splits them. */
const LOOKAHEAD = 2;
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

function findTotal(allLines: readonly string[], currency: string): Field<Money> | null {
  const amounts = (line: string): Money[] =>
    (line.match(AMOUNT) ?? [])
      .map((raw) => parseMoney(raw, currency))
      .filter((money): money is Money => money !== null && money.minor > 0);

  // The bill ends where the tax table starts.
  const end = allLines.findIndex((line) => TAX_TABLE.test(line));
  const lines = end === -1 ? allLines : allLines.slice(0, end);

  /** The amount on a labelled line, or on one of the next few lines. */
  const amountFor = (i: number): Money | undefined => {
    const own = amounts(lines[i]!).at(-1);
    if (own !== undefined) return own;
    for (let j = i + 1; j <= i + LOOKAHEAD && j < lines.length; j++) {
      const found = amounts(lines[j]!).at(0);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const candidates: Money[] = [];
  lines.forEach((line, i) => {
    if (!TOTAL_LABEL.test(line)) return;
    if (NOT_TOTAL.test(line) && !INCLUSIVE.test(line)) return;
    const found = amountFor(i);
    if (found !== undefined) candidates.push(found);
  });

  // Cash handed over minus change given back is what was paid: the one figure a
  // receipt states twice over. When it agrees with a labelled total, or there is no
  // labelled total, it decides.
  const cashLine = lines.findIndex((line) => CASH.test(line) && !CHANGE.test(line));
  const changeLine = lines.findIndex((line) => CHANGE.test(line));
  const cash = cashLine === -1 ? undefined : amountFor(cashLine);
  const change = changeLine === -1 ? undefined : amountFor(changeLine);
  if (cash !== undefined && change !== undefined && cash.minor > change.minor) {
    const paid: Money = { minor: cash.minor - change.minor, currency: cash.currency };
    if (candidates.length === 0 || candidates.some((c) => c.minor === paid.minor)) {
      return { value: paid, confidence: 0.85 };
    }
  }

  // Otherwise the last labelled total: receipts print one before discounts or
  // rounding and again after, and the later one is what was paid.
  const last = candidates.at(-1);
  if (last !== undefined) return { value: last, confidence: 0.8 };

  // Last resort: the largest amount, leaving out what was handed over and given
  // back, which are at least as large as the bill and never it.
  const paying = new Set<number>();
  lines.forEach((line, i) => {
    if (!CASH.test(line) && !CHANGE.test(line)) return;
    for (let j = i; j <= i + LOOKAHEAD; j++) paying.add(j);
  });
  const all = lines.filter((_, i) => !paying.has(i)).flatMap(amounts);
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
