import type { MatchingAlgorithm, MatchingRule } from '@sheaf/protocol';
import { mark, t } from './i18n';

/** Each algorithm's name, marked here and put through `t` where it is drawn. */
export const ALGORITHM_NAMES: Readonly<Record<MatchingAlgorithm, string>> = {
  none: mark('Never on its own'),
  any: mark('Any of these words'),
  all: mark('All of these words'),
  exact: mark('This exact text'),
  regex: mark('Regular expression'),
  fuzzy: mark('Roughly this text'),
};

/** A rule's description for the list, one sentence per algorithm so each language can word it. */
const FINDS: Readonly<Record<Exclude<MatchingAlgorithm, 'none'>, string>> = {
  any: mark('finds any of these words: {pattern}'),
  all: mark('finds all of these words: {pattern}'),
  exact: mark('finds this exact text: {pattern}'),
  regex: mark('finds regular expression: {pattern}'),
  fuzzy: mark('finds roughly this text: {pattern}'),
};

/** A rule in a few words, for the list. */
export function describeRule(rule: MatchingRule): string | null {
  if (rule.algorithm === 'none') return null;
  const finds = t(FINDS[rule.algorithm], { pattern: rule.pattern });
  return rule.caseSensitive ? t('{rule} (case matters)', { rule: finds }) : finds;
}
