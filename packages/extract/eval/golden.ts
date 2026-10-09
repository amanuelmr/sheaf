/**
 * The shape of the golden set, and how SROIE's labelled lines become it.
 *
 * SROIE (ICDAR 2019) receipts come as OCR lines, each labelled `company`, `date`,
 * `address`, `total`, a line-item label, or `other`. The expected answer is read off
 * those labels with the same normalisers the extractors use, so a correct extractor
 * and the label agree exactly.
 */
import { parseDate, parseMoney } from '../src/normalise.ts';
import type { Money } from '../src/schema.ts';

export interface Expected {
  readonly correspondent?: string;
  /** `YYYY-MM-DD`. */
  readonly date?: string;
  readonly total?: Money;
}

export interface GoldenDocument {
  readonly id: string;
  readonly text: string;
  readonly expected: Expected;
  /** Settings the extractor runs with, which the labels assume. */
  readonly currency: string;
}

export interface SroieLine {
  readonly label: string;
  readonly text: string;
  /** Four corner points; the first is the top left. */
  readonly box: readonly (readonly [number, number])[];
}

/** SROIE receipts are Malaysian, dated day first. */
export const SROIE_CURRENCY = 'MYR';
export const SROIE_TODAY = '2026-10-05';

export function fromSroie(id: string, lines: readonly SroieLine[]): GoldenDocument {
  // Reading order: top to bottom, then left to right on a row.
  const ordered = [...lines].sort(
    (a, b) => a.box[0]![1] - b.box[0]![1] || a.box[0]![0] - b.box[0]![0],
  );
  const labelled = (label: string): string[] =>
    ordered.filter((line) => line.label === label).map((line) => line.text.trim());

  const company = labelled('company').join(' ').replace(/\s+/g, ' ').trim();
  const date = labelled('date')
    .map((text) => parseDate(text, { order: 'DMY', today: SROIE_TODAY }))
    .find((iso) => iso !== null);
  // Several lines can carry the total label ("TOTAL", "60.30"); the amount is the
  // last one with digits in it.
  const total = labelled('total')
    .filter((text) => /\d/.test(text))
    .map((text) => parseMoney(text, SROIE_CURRENCY))
    .filter((money): money is Money => money !== null)
    .at(-1);

  return {
    id: `sroie-${id}`,
    text: ordered.map((line) => line.text).join('\n'),
    currency: SROIE_CURRENCY,
    expected: {
      ...(company === '' ? {} : { correspondent: company }),
      ...(date === undefined ? {} : { date }),
      ...(total === undefined ? {} : { total }),
    },
  };
}
