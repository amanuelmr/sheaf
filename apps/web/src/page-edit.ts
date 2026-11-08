import { parsePageList, type PageSpec } from '@sheaf/protocol';

/** A page in the editor: which page it was, how far it is turned, and whether it stays. */
export interface PageRow {
  readonly page: number;
  readonly rotate: 0 | 90 | 180 | 270;
  readonly removed: boolean;
}

export function initialRows(count: number): PageRow[] {
  return Array.from({ length: count }, (_, i) => ({ page: i + 1, rotate: 0, removed: false }));
}

export function turn(rows: readonly PageRow[], index: number, by: 90 | 270): PageRow[] {
  return rows.map((row, i) =>
    i === index ? { ...row, rotate: ((row.rotate + by) % 360) as PageRow['rotate'] } : row,
  );
}

export function move(rows: readonly PageRow[], index: number, by: -1 | 1): PageRow[] {
  const target = index + by;
  if (target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** The pages to send, or null when nothing would change. */
export function pagesToSend(rows: readonly PageRow[]): PageSpec[] | null {
  const unchanged = rows.every((row, i) => row.page === i + 1 && row.rotate === 0 && !row.removed);
  if (unchanged) return null;
  return rows
    .filter((row) => !row.removed)
    .map((row) => (row.rotate === 0 ? { page: row.page } : { page: row.page, rotate: row.rotate }));
}

/** "1-2; 3-5" as parts [[1, 2], [3, 4, 5]], checked against the page count; null if not. */
export function parseParts(text: string, count: number): number[][] | null {
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(parsePageList);
  if (parts.length === 0 || parts.some((part) => part === null)) return null;
  const valid = parts as number[][];
  return valid.every((part) => part.every((page) => page <= count)) ? valid : null;
}
