/**
 * Turning what someone typed into an FTS5 query that cannot fail.
 *
 * FTS5 has its own query language: `:` filters by column, `"` quotes, `AND`, `OR`,
 * `NOT`, `NEAR`, `*`, `^` and parentheses all mean something, and a malformed query
 * is an error rather than an empty result. Passing input through would make a
 * search for `total: 12.50` fail, which is exactly the bug the contract tests found
 * in Paperless's own search (README, "Contract tests").
 *
 * So input is never parsed as a query. It is split into words, each word is quoted
 * and made a prefix, and the words are ANDed: every word must appear, and the last
 * one may still be being typed.
 */

/** Enough for any real search; bounds the cost of a pasted paragraph. */
export const MAX_TERMS = 12;

/** Words: runs of letters and digits in any script. Everything else separates them. */
const WORD = /[\p{L}\p{N}]+/gu;

/** `null` when there is nothing to search for, which callers answer with no results. */
export function toMatch(input: string): string | null {
  const terms = input.normalize('NFKC').toLowerCase().match(WORD) ?? [];
  if (terms.length === 0) return null;
  // Quoting makes each term a plain string to FTS5, so `and`, `near` or `not` typed
  // as words are searched for rather than obeyed. A term is only ever letters and
  // digits, so it can never contain the quote that would end it early.
  return [...new Set(terms)]
    .slice(0, MAX_TERMS)
    .map((term) => `"${term}"*`)
    .join(' AND ');
}
