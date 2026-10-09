/**
 * Scoring extraction against the golden set (ADR 0010). Pure, so a report can be
 * recomputed from saved predictions.
 *
 * A missing prediction counts as wrong, and coverage (how often a value came back
 * at all) is reported beside accuracy, so an extractor cannot look accurate by
 * answering only when sure.
 */
import { normaliseName } from '../src/normalise.ts';
import type { ExtractedFields } from '../src/schema.ts';
import type { Expected } from './golden.ts';

export const SCORED_FIELDS = ['date', 'total', 'correspondent', 'correspondentFuzzy'] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export interface Verdict {
  readonly field: ScoredField;
  readonly predicted: boolean;
  readonly correct: boolean;
  readonly expected: string;
  readonly got: string;
}

export function judge(expected: Expected, fields: ExtractedFields): readonly Verdict[] {
  const verdicts: Verdict[] = [];
  if (expected.date !== undefined) {
    verdicts.push({
      field: 'date',
      predicted: fields.date !== undefined,
      correct: fields.date?.value === expected.date,
      expected: expected.date,
      got: fields.date?.value ?? '—',
    });
  }
  if (expected.total !== undefined) {
    const got = fields.total?.value;
    verdicts.push({
      field: 'total',
      predicted: got !== undefined,
      correct: got?.minor === expected.total.minor && got.currency === expected.total.currency,
      expected: money(expected.total),
      got: got === undefined ? '—' : money(got),
    });
  }
  if (expected.correspondent !== undefined) {
    const got = fields.correspondent?.value;
    const exact = got !== undefined && normaliseName(got) === normaliseName(expected.correspondent);
    for (const field of ['correspondent', 'correspondentFuzzy'] as const) {
      verdicts.push({
        field,
        predicted: got !== undefined,
        correct:
          field === 'correspondent'
            ? exact
            : got !== undefined && tokenF1(got, expected.correspondent) >= 0.8,
        expected: expected.correspondent,
        got: got ?? '—',
      });
    }
  }
  return verdicts;
}

/** Overlap of the two names' words, as F1: 1 when they share every word. */
export function tokenF1(a: string, b: string): number {
  const x = new Set(normaliseName(a).split(' ').filter(Boolean));
  const y = new Set(normaliseName(b).split(' ').filter(Boolean));
  if (x.size === 0 || y.size === 0) return x.size === y.size ? 1 : 0;
  const common = [...x].filter((word) => y.has(word)).length;
  if (common === 0) return 0;
  const precision = common / x.size;
  const recall = common / y.size;
  return (2 * precision * recall) / (precision + recall);
}

export interface FieldScore {
  readonly n: number;
  /** Percent of documents with this field labelled that were answered correctly. */
  readonly accuracy: number;
  /** Percent that were answered at all. */
  readonly coverage: number;
}

export function aggregate(verdicts: readonly Verdict[]): Readonly<Record<ScoredField, FieldScore>> {
  const result = {} as Record<ScoredField, FieldScore>;
  for (const field of SCORED_FIELDS) {
    const mine = verdicts.filter((verdict) => verdict.field === field);
    const n = mine.length;
    const pct = (count: number): number => (n === 0 ? 0 : Math.round((count / n) * 1000) / 10);
    result[field] = {
      n,
      accuracy: pct(mine.filter((verdict) => verdict.correct).length),
      coverage: pct(mine.filter((verdict) => verdict.predicted).length),
    };
  }
  return result;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function money(value: { minor: number; currency: string }): string {
  return `${value.currency} ${(value.minor / 100).toFixed(2)}`;
}
