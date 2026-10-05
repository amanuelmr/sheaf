import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { MAX_TERMS, toMatch } from '../src/search-query';

suite('toMatch', () => {
  it('makes every word required and lets the last one be half-typed', () => {
    expect(toMatch('cinema receipt')).toBe('"cinema"* AND "receipt"*');
  });

  it('finds nothing to search for in punctuation or whitespace', () => {
    for (const input of ['', '   ', '!!!', ':', '""', '***', '()']) {
      expect(toMatch(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('lower-cases, normalises full-width characters, and drops repeats', () => {
    expect(toMatch('ＴＯＴＡＬ total Total')).toBe('"total"*');
  });

  it('keeps words in any script, and digits', () => {
    expect(toMatch('Café 12.50 መዝገብ')).toBe('"café"* AND "12"* AND "50"* AND "መዝገብ"*');
  });

  it('caps the number of terms', () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${String(i)}`).join(' ');
    expect(toMatch(words)!.split(' AND ')).toHaveLength(MAX_TERMS);
  });

  // The property that matters: whatever is typed, SQLite accepts the query.
  it.each([
    'total: 12.50',
    'title:receipt',
    '"unterminated',
    'a AND OR NOT NEAR(b c)',
    'receipt*^',
    '(((',
    '- minus -',
    '🧾 receipt 🎬',
    'x'.repeat(2_000),
    "O'Reilly & Sons, Inc.",
  ])('produces a query FTS5 accepts for %j', (input) => {
    const db = nodeSqliteDriver();
    const match = toMatch(input);
    return db
      .exec('CREATE VIRTUAL TABLE t USING fts5(body)')
      .then(() => db.run("INSERT INTO t VALUES ('total 12.50 at the cinema, O''Reilly')"))
      .then(() => (match === null ? [] : db.all('SELECT rowid FROM t WHERE t MATCH ?', [match])))
      .then((rows) => expect(Array.isArray(rows)).toBe(true));
  });
});
