import type { MatchingAlgorithm, MatchingRule } from '@sheaf/protocol';

export const ALGORITHM_NAMES: Readonly<Record<MatchingAlgorithm, string>> = {
  none: 'Never on its own',
  any: 'Any of these words',
  all: 'All of these words',
  exact: 'This exact text',
  regex: 'Regular expression',
  fuzzy: 'Roughly this text',
};

/** A rule in a few words, for the list. */
export function describeRule(rule: MatchingRule): string | null {
  if (rule.algorithm === 'none') return null;
  const how = ALGORITHM_NAMES[rule.algorithm].toLowerCase();
  return `finds ${how}: ${rule.pattern}${rule.caseSensitive ? ' (case matters)' : ''}`;
}
