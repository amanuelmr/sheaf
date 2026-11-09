/**
 * Turning the way dates, amounts and names are written into one form each.
 *
 * Every extractor's output passes through here, the regex one and the language
 * models alike, so they can be compared field for field (ADR 0010). Pure: "today"
 * is a parameter, and nothing reads a clock.
 */

import { minorDigits } from '@sheaf/protocol';
import type { Money } from './schema.ts';

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export interface DateOptions {
  /** How to read an ambiguous all-numeric date such as 05/10/2026. */
  readonly order: DateOrder;
  /** `YYYY-MM-DD`. Decides the century of a two-digit year. */
  readonly today: string;
}

export interface FoundDate {
  readonly iso: string;
  /** Where in the text it starts. */
  readonly index: number;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Month names in German, French, Spanish, Italian, Dutch and Portuguese, whole and
 * shortened, where their first three letters do not already say the month in
 * English: "März", "févr.", "enero", "mei".
 */
const LOCAL_MONTHS: Readonly<Record<string, number>> = {
  januar: 1,
  jänner: 1,
  janvier: 1,
  enero: 1,
  gennaio: 1,
  januari: 1,
  janeiro: 1,
  ene: 1,
  gen: 1,
  janv: 1,
  februar: 2,
  février: 2,
  fevrier: 2,
  febrero: 2,
  febbraio: 2,
  februari: 2,
  fevereiro: 2,
  févr: 2,
  fev: 2,
  fév: 2,
  märz: 3,
  maerz: 3,
  mär: 3,
  mars: 3,
  marzo: 3,
  maart: 3,
  março: 3,
  marco: 3,
  avril: 4,
  abril: 4,
  aprile: 4,
  avr: 4,
  abr: 4,
  mai: 5,
  mayo: 5,
  maggio: 5,
  mei: 5,
  maio: 5,
  mag: 5,
  juni: 6,
  juin: 6,
  junio: 6,
  giugno: 6,
  junho: 6,
  giu: 6,
  juli: 7,
  juillet: 7,
  julio: 7,
  luglio: 7,
  julho: 7,
  juil: 7,
  lug: 7,
  août: 8,
  aout: 8,
  agosto: 8,
  augustus: 8,
  ago: 8,
  septembre: 9,
  septiembre: 9,
  setiembre: 9,
  settembre: 9,
  setembro: 9,
  set: 9,
  oktober: 10,
  octobre: 10,
  octubre: 10,
  ottobre: 10,
  outubro: 10,
  okt: 10,
  ott: 10,
  out: 10,
  novembre: 11,
  noviembre: 11,
  novembro: 11,
  dezember: 12,
  décembre: 12,
  decembre: 12,
  diciembre: 12,
  dicembre: 12,
  dezembro: 12,
  dez: 12,
  déc: 12,
  dic: 12,
};
const LOCAL_NAMES = Object.keys(LOCAL_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const MONTH = `(${LOCAL_NAMES}|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?`;
// 1st, 3. (German), 1er (French), 1º (Spanish and Portuguese).
const ORDINAL = '(?:st|nd|rd|th|er|º|\\.)?';

/** Every pattern, tried at each position. Groups are named by what they hold. */
const PATTERNS: readonly {
  readonly re: RegExp;
  readonly kind: 'ymd' | 'numeric' | 'dmonth' | 'monthd';
}[] = [
  { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/y, kind: 'ymd' },
  { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/y, kind: 'numeric' },
  {
    // "15 de enero de 2026" in Spanish and Portuguese.
    re: new RegExp(
      `\\b(\\d{1,2})${ORDINAL}\\s+(?:de\\s+)?${MONTH}\\s*,?\\s*(?:de\\s+)?(\\d{4}|\\d{2})\\b`,
      'iy',
    ),
    kind: 'dmonth',
  },
  {
    re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}(?:\\s*,\\s*|\\s+)(\\d{4}|\\d{2})\\b`, 'iy'),
    kind: 'monthd',
  },
];

/** Every valid date in a text, in order of appearance. */
export function findDates(text: string, options: DateOptions): readonly FoundDate[] {
  const found: FoundDate[] = [];
  for (let index = 0; index < text.length; index++) {
    for (const { re, kind } of PATTERNS) {
      re.lastIndex = index;
      const m = re.exec(text);
      if (m === null) continue;
      const iso = toIso(kind, m, options);
      if (iso !== null) {
        found.push({ iso, index });
        index = re.lastIndex - 1;
        break;
      }
    }
  }
  return found;
}

/** The first valid date in a text, as `YYYY-MM-DD`, or null. */
export function parseDate(text: string, options: DateOptions): string | null {
  return findDates(text, options)[0]?.iso ?? null;
}

function toIso(
  kind: 'ymd' | 'numeric' | 'dmonth' | 'monthd',
  m: RegExpExecArray,
  options: DateOptions,
): string | null {
  switch (kind) {
    case 'ymd':
      return valid(Number(m[1]), Number(m[2]), Number(m[3]));
    case 'dmonth':
      return valid(year(m[3]!, options.today), monthNumber(m[2]!), Number(m[1]));
    case 'monthd':
      return valid(year(m[3]!, options.today), monthNumber(m[1]!), Number(m[2]));
    case 'numeric': {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const y = year(m[3]!, options.today);
      // A part over 12 cannot be the month, whatever the configured order says.
      const dayFirst = a > 12 ? true : b > 12 ? false : options.order !== 'MDY';
      return dayFirst ? valid(y, b, a) : valid(y, a, b);
    }
  }
}

function monthNumber(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  for (const [local, month] of Object.entries(LOCAL_MONTHS)) {
    if (lower.startsWith(local)) return month;
  }
  // Three letters are enough to tell the English months apart; "sept" starts with "sep".
  return MONTHS[lower.slice(0, 3)] ?? 0;
}

/** A two-digit year is this century, unless that puts it more than a year ahead. */
function year(raw: string, today: string): number {
  if (raw.length === 4) return Number(raw);
  const yy = Number(raw);
  const thisYear = Number(today.slice(0, 4));
  const candidate = 2000 + yy;
  return candidate > thisYear + 1 ? 1900 + yy : candidate;
}

function valid(y: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > days) return null;
  return `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Symbols and words that name a currency, longest first so `CHF` beats `$`. */
const CURRENCY_MARKS: readonly (readonly [RegExp, string])[] = [
  [/\b(EUR|USD|GBP|CHF|JPY|MYR|INR|ETB|CAD|AUD|NZD|SGD)\b/i, ''],
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/¥/, 'JPY'],
  [/₹/, 'INR'],
  [/\bRM\b/, 'MYR'],
  [/\bBr\b/, 'ETB'],
  [/\$/, '$'],
];
const DOLLARS = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD']);

/**
 * An amount of money, in integer minor units: `€12,50` is 1250 EUR. Never a float,
 * so no total is ever off by a rounding error.
 *
 * The decimal mark is whichever of `.` and `,` comes last with one or two digits
 * after it; every other separator groups thousands. So `1.234,56` and `1,234.56`
 * both read as 1234.56, `1,000` as one thousand, and `0,5` as a half.
 */
export function parseMoney(text: string, defaultCurrency: string): Money | null {
  const currency = currencyOf(text, defaultCurrency);
  const numeric = /(\(?)-?\s*\d[\d.,' \u00a0]*/.exec(text);
  if (numeric === null) return null;
  const negative = numeric[1] === '(' || /-\s*\d/.test(numeric[0]);
  const raw = numeric[0].replace(/[(\s\u00a0-]/g, '').replace(/[.,']+$/, '');

  const decimal = /^(.*?)[.,](\d{1,2})$/.exec(raw);
  const whole = (decimal === null ? raw : decimal[1]!).replace(/[.,']/g, '');
  const digits = minorDigits(currency);
  const fraction = decimal === null ? '' : decimal[2]!.padEnd(digits, '0');
  // Separators left in the whole part must each group exactly three digits.
  if (decimal !== null && /[.,]\d{1,2}[.,]/.test(raw)) return null;
  if (!/^\d{1,13}$/.test(whole)) return null;

  // A currency with no minor unit ignores what follows the decimal mark, as before.
  const minor =
    Number(whole) * 10 ** digits + (fraction === '' || digits === 0 ? 0 : Number(fraction));
  return { minor: negative ? -minor : minor, currency };
}

function currencyOf(text: string, defaultCurrency: string): string {
  for (const [mark, code] of CURRENCY_MARKS) {
    const m = mark.exec(text);
    if (m === null) continue;
    if (code === '') return m[1]!.toUpperCase();
    if (code === '$') return DOLLARS.has(defaultCurrency) ? defaultCurrency : 'USD';
    return code;
  }
  return defaultCurrency;
}

const LEGAL_SUFFIXES = new Set([
  'ltd',
  'limited',
  'gmbh',
  'inc',
  'llc',
  'plc',
  'co',
  'corp',
  'corporation',
  'bhd',
  'sdn',
  'ag',
  'sa',
  'sarl',
  'bv',
  'srl',
  'pty',
  'company',
]);

/**
 * A name reduced to what identifies it, for comparing: `ACME Ltd.` and `Acme` are
 * both `acme`. A name that is nothing but a suffix keeps it rather than vanishing.
 */
export function normaliseName(name: string): string {
  const words = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(' ');
}

/** 1 for the same name, falling towards 0 as more edits are needed to match. */
export function similarity(a: string, b: string): number {
  const x = normaliseName(a);
  const y = normaliseName(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

/**
 * The known name a candidate most likely means, or null if none is close. Keeps
 * "ACME Ltd." and "Acme" from becoming two correspondents.
 */
export function matchVocabulary(
  candidate: string,
  names: readonly string[],
  threshold = 0.85,
): string | null {
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    const score = similarity(candidate, name);
    if (score >= threshold && (best === null || score > best.score)) best = { name, score };
  }
  return best?.name ?? null;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
