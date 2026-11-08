import {
  minorDigits,
  type CustomFieldData,
  type MonetaryValue,
  type SearchHit,
  type SearchResponse,
} from '@sheaf/protocol';
import type { CustomFields } from './custom-fields.ts';

/** The most rows one export holds: enough for a tax year, small enough to build in memory. */
export const MAX_EXPORT_ROWS = 10_000;

const PAGE = 100;

const BASE_COLUMNS = [
  'id',
  'title',
  'created',
  'received',
  'correspondent',
  'document type',
  'tags',
  'asn',
] as const;

/**
 * One cell, quoted when it has to be. A cell a spreadsheet would read as a formula
 * starts with an apostrophe, so opening an export never runs what a document said.
 */
export function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function fieldText(value: CustomFieldData | null): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.join(' ');
  const { minor, currency } = value as MonetaryValue;
  const digits = minorDigits(currency);
  return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
}

/**
 * Every document the filter lets through, as CSV: one row each, in the filter's
 * order, with a column per custom field. The second value says whether there were
 * more than fit.
 */
export async function exportCsv(
  find: (limit: number, offset: number) => Promise<SearchResponse>,
  customFields: CustomFields | undefined,
): Promise<{ readonly csv: string; readonly truncated: boolean }> {
  const hits: SearchHit[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += PAGE) {
    const page = await find(PAGE, offset);
    hits.push(...page.hits);
    if (!page.hasMore) break;
    if (hits.length >= MAX_EXPORT_ROWS) {
      truncated = true;
      break;
    }
  }
  const fields = customFields === undefined ? [] : await customFields.list();
  const lines = [[...BASE_COLUMNS, ...fields.map((f) => f.name)].map(cell).join(',')];
  for (const hit of hits.slice(0, MAX_EXPORT_ROWS)) {
    const values = new Map(
      (customFields === undefined ? [] : await customFields.valuesOf(hit.sha256)).map((v) => [
        v.field,
        fieldText(v.value),
      ]),
    );
    const row = [
      hit.sha256,
      hit.title ?? '',
      hit.created ?? '',
      new Date(hit.receivedAt).toISOString(),
      hit.correspondent ?? '',
      hit.documentType ?? '',
      hit.tags.join('; '),
      hit.asn === null ? '' : String(hit.asn),
      ...fields.map((f) => values.get(f.id) ?? ''),
    ];
    lines.push(row.map(cell).join(','));
  }
  // A byte-order mark, so a spreadsheet reads the accents in names right.
  return {
    csv: `\uFEFF${lines.join('\r\n')}\r\n`,
    truncated: truncated || hits.length > MAX_EXPORT_ROWS,
  };
}
