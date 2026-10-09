import { describe as suite, expect, it } from 'vitest';
import { aggregate, judge, percentile, tokenF1 } from '../eval/score';

const EXPECTED = {
  correspondent: 'PERNIAGAAN ZHENG HUI',
  date: '2018-02-12',
  total: { minor: 11245, currency: 'MYR' },
};

suite('judging one document', () => {
  it('marks exact answers correct, field by field', () => {
    const verdicts = judge(EXPECTED, {
      date: { value: '2018-02-12', confidence: 1 },
      total: { value: { minor: 11245, currency: 'MYR' }, confidence: 1 },
      correspondent: { value: 'Perniagaan Zheng Hui Sdn Bhd', confidence: 1 },
    });
    expect(verdicts.every((verdict) => verdict.correct)).toBe(true);
  });

  it('counts a missing answer as wrong, and as not covered', () => {
    const verdicts = judge(EXPECTED, {});
    expect(verdicts.map((v) => [v.field, v.predicted, v.correct])).toEqual([
      ['date', false, false],
      ['total', false, false],
      ['correspondent', false, false],
      ['correspondentFuzzy', false, false],
    ]);
  });

  it('gives a near name the fuzzy point but not the exact one', () => {
    const verdicts = judge(
      { correspondent: 'SANYU STATIONERY SHOP' },
      { correspondent: { value: 'SANYU STATIONERY', confidence: 1 } },
    );
    expect(verdicts.map((v) => [v.field, v.correct])).toEqual([
      ['correspondent', false],
      ['correspondentFuzzy', true],
    ]);
  });

  it('needs the currency right as well as the amount', () => {
    const [verdict] = judge(
      { total: { minor: 100, currency: 'MYR' } },
      { total: { value: { minor: 100, currency: 'USD' }, confidence: 1 } },
    );
    expect(verdict!.correct).toBe(false);
  });
});

suite('scores', () => {
  it('reports accuracy and coverage as percentages to one decimal place', () => {
    const verdicts = [
      ...judge(EXPECTED, { date: { value: '2018-02-12', confidence: 1 } }),
      ...judge(EXPECTED, { date: { value: '2018-02-13', confidence: 1 } }),
      ...judge(EXPECTED, {}),
    ];
    expect(aggregate(verdicts).date).toEqual({ n: 3, accuracy: 33.3, coverage: 66.7 });
  });

  it('scores word overlap', () => {
    expect(tokenF1('Acme Trading', 'ACME TRADING SDN BHD')).toBe(1);
    expect(tokenF1('Acme', 'Acme Trading')).toBeCloseTo(0.667, 3);
    expect(tokenF1('Acme', 'Zebra')).toBe(0);
  });

  it('takes percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});
