import type { MatchingRule } from '@sheaf/protocol';

/**
 * Whether a label's rule finds it in a document's text.
 *
 * `any` and `all` look for whole words, so "tax" does not match "taxi". `exact` and
 * `regex` look anywhere. `fuzzy` allows one wrong, missing or extra letter per ten,
 * which is what a misread scan usually costs; a pattern under ten letters must
 * match exactly. Punctuation and runs of spaces count as one space for `fuzzy`.
 */
export function matches(rule: MatchingRule, text: string): boolean {
  const flags = rule.caseSensitive ? 'u' : 'iu';
  switch (rule.algorithm) {
    case 'none':
      return false;
    case 'any':
      return terms(rule.pattern).some((term) => hasWord(term, text, flags));
    case 'all': {
      const all = terms(rule.pattern);
      return all.length > 0 && all.every((term) => hasWord(term, text, flags));
    }
    case 'exact':
      return new RegExp(escape(rule.pattern), flags).test(text);
    case 'regex':
      return new RegExp(rule.pattern, flags).test(text);
    case 'fuzzy':
      return fuzzy(rule.pattern, text, rule.caseSensitive);
  }
}

/** The words of a pattern, where a "quoted phrase" is one word. */
export function terms(pattern: string): string[] {
  const found: string[] = [];
  for (const match of pattern.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? '').trim().replace(/\s+/g, ' ');
    if (term !== '') found.push(term);
  }
  return found;
}

function hasWord(term: string, text: string, flags: string): boolean {
  const spaced = escape(term).replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${spaced}(?![\\p{L}\\p{N}])`, flags).test(text);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simplify(text: string, caseSensitive: boolean): string {
  const plain = text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return caseSensitive ? plain : plain.toLowerCase();
}

/**
 * The fewest edits that turn the pattern into some stretch of the text, at most
 * the allowance: one column of edit distances, with every start in the text free.
 */
function fuzzy(pattern: string, text: string, caseSensitive: boolean): boolean {
  const p = simplify(pattern, caseSensitive);
  const t = simplify(text, caseSensitive);
  if (p === '') return false;
  if (t.includes(p)) return true;
  const allowed = Math.floor(p.length / 10);
  if (allowed === 0) return false;

  let column = Array.from({ length: p.length + 1 }, (_, i) => i);
  for (const char of t) {
    const next = [0];
    for (let i = 1; i <= p.length; i++) {
      next.push(
        Math.min(column[i]! + 1, next[i - 1]! + 1, column[i - 1]! + (p[i - 1] === char ? 0 : 1)),
      );
    }
    if (next[p.length]! <= allowed) return true;
    column = next;
  }
  return false;
}
