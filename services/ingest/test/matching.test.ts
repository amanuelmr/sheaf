/** Each algorithm finding, or rightly not finding, a label in a document's text. */
import { describe as suite, expect, it } from 'vitest';
import type { MatchingAlgorithm } from '@sheaf/protocol';
import { matches, terms } from '../src/matching';

const rule = (algorithm: MatchingAlgorithm, pattern: string, caseSensitive = false) => ({
  algorithm,
  pattern,
  caseSensitive,
});
const BILL = 'Your City-Power bill for March.\nAccount 4471, amount due EUR 52.10';

suite('matching', () => {
  it('splits a pattern into words, keeping a quoted phrase whole', () => {
    expect(terms('rent "city  power" tax')).toEqual(['rent', 'city power', 'tax']);
  });

  it('never matches with none', () => {
    expect(matches(rule('none', ''), BILL)).toBe(false);
  });

  it('matches any one whole word', () => {
    expect(matches(rule('any', 'water bill'), BILL)).toBe(true);
    expect(matches(rule('any', 'mar'), BILL)).toBe(false);
    expect(matches(rule('any', 'water gas'), BILL)).toBe(false);
  });

  it('matches all the words in any order', () => {
    expect(matches(rule('all', 'march bill'), BILL)).toBe(true);
    expect(matches(rule('all', 'march water'), BILL)).toBe(false);
  });

  it('matches a quoted phrase across a line break', () => {
    expect(matches(rule('any', '"march account"'), 'for March\nAccount 1')).toBe(true);
  });

  it('matches the exact text anywhere', () => {
    expect(matches(rule('exact', 'City-Power'), BILL)).toBe(true);
    expect(matches(rule('exact', 'City Power'), BILL)).toBe(false);
  });

  it('matches a regular expression', () => {
    expect(matches(rule('regex', 'account \\d{4}'), BILL)).toBe(true);
    expect(matches(rule('regex', '^amount'), BILL)).toBe(false);
  });

  it('ignores case unless told not to', () => {
    expect(matches(rule('any', 'MARCH'), BILL)).toBe(true);
    expect(matches(rule('any', 'MARCH', true), BILL)).toBe(false);
    expect(matches(rule('regex', 'march', true), BILL)).toBe(false);
  });

  it('forgives a misread letter per ten, ignoring punctuation', () => {
    expect(matches(rule('fuzzy', 'City Power bill'), BILL)).toBe(true);
    expect(matches(rule('fuzzy', 'City Pover bill'), BILL)).toBe(true);
    expect(matches(rule('fuzzy', 'City Pover blil'), BILL)).toBe(false);
    expect(matches(rule('fuzzy', 'Mrach'), BILL)).toBe(false);
  });
});
