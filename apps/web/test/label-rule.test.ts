/** A label's rule, put in a few words for the list. */
import { describe as suite, expect, it } from 'vitest';
import { describeRule } from '../src/label-rule';

suite('describing a rule', () => {
  it('says nothing for a label without one', () => {
    expect(describeRule({ algorithm: 'none', pattern: '', caseSensitive: false })).toBeNull();
  });

  it('names the algorithm, the pattern and whether case matters', () => {
    expect(describeRule({ algorithm: 'any', pattern: 'gas water', caseSensitive: false })).toBe(
      'finds any of these words: gas water',
    );
    expect(describeRule({ algorithm: 'regex', pattern: '^INV', caseSensitive: true })).toBe(
      'finds regular expression: ^INV (case matters)',
    );
  });
});
