import { describe as suite, expect, it } from 'vitest';
import {
  findDates,
  matchVocabulary,
  normaliseName,
  parseDate,
  parseMoney,
  similarity,
} from '../src/normalise';

const TODAY = '2026-10-05';
const DMY = { order: 'DMY', today: TODAY } as const;
const MDY = { order: 'MDY', today: TODAY } as const;

suite('parseDate', () => {
  it.each([
    ['2026-10-05', '2026-10-05'],
    ['2026/10/05', '2026-10-05'],
    ['05/10/2026', '2026-10-05'],
    ['5.10.26', '2026-10-05'],
    ['05-10-2026', '2026-10-05'],
    ['5 Oct 2026', '2026-10-05'],
    ['5th October 2026', '2026-10-05'],
    ['October 5, 2026', '2026-10-05'],
    ['Oct. 5th, 2026', '2026-10-05'],
    ['Date: 31/12/2025 14:02', '2025-12-31'],
    ['09/03/2018', '2018-03-09'],
  ])('reads %j as %s, day first', (raw, iso) => {
    expect(parseDate(raw, DMY)).toBe(iso);
  });

  it('reads an ambiguous date in the configured order', () => {
    expect(parseDate('05/10/2026', MDY)).toBe('2026-05-10');
    expect(parseDate('05/10/2026', DMY)).toBe('2026-10-05');
  });

  it('lets an impossible reading settle the order', () => {
    // 13 cannot be a month, so this is the 13th whichever order was configured.
    expect(parseDate('10/13/2026', DMY)).toBe('2026-10-13');
    expect(parseDate('13/10/2026', MDY)).toBe('2026-10-13');
  });

  it('places a two-digit year in this century unless that would be far in the future', () => {
    expect(parseDate('01/02/27', DMY)).toBe('2027-02-01');
    expect(parseDate('01/02/99', DMY)).toBe('1999-02-01');
  });

  it.each(['31/02/2026', '29/02/2026', '00/10/2026', '2026-13-01', '32.01.2026'])(
    'refuses the impossible date %j',
    (raw) => {
      expect(parseDate(raw, DMY)).toBeNull();
    },
  );

  it('accepts the 29th of February in a leap year', () => {
    expect(parseDate('29/02/2028', DMY)).toBe('2028-02-29');
  });

  it.each(['', 'no date here', '2026', '12.50', 'Oct 2026', '1234567'])(
    'finds no date in %j',
    (raw) => {
      expect(parseDate(raw, DMY)).toBeNull();
    },
  );

  it('finds every date in a text, with where each one is', () => {
    const found = findDates('Issued 01/09/2026, due 2026-10-01.', DMY);
    expect(found.map((d) => d.iso)).toEqual(['2026-09-01', '2026-10-01']);
    expect(found[0]!.index).toBe(7);
  });
});

suite('parseMoney', () => {
  it.each([
    ['€12,50', 1250, 'EUR'],
    ['12,50 €', 1250, 'EUR'],
    ['1.234,56 EUR', 123456, 'EUR'],
    ['$1,234.56', 123456, 'USD'],
    ['USD 1,234.56', 123456, 'USD'],
    ['£3.99', 399, 'GBP'],
    ["CHF 1'234.50", 123450, 'CHF'],
    ['RM 29.90', 2990, 'MYR'],
    ['12.50', 1250, 'EUR'],
    ['12.5', 1250, 'EUR'],
    ['0,5', 50, 'EUR'],
    ['1,000', 100000, 'EUR'],
    ['1.000', 100000, 'EUR'],
    ['-3.00', -300, 'EUR'],
    ['(3.00)', -300, 'EUR'],
    ['TOTAL 99', 9900, 'EUR'],
    ['1 234,56', 123456, 'EUR'],
  ])('reads %j as %d %s', (raw, minor, currency) => {
    expect(parseMoney(raw, 'EUR')).toEqual({ minor, currency });
  });

  it('counts yen in whole yen, which have no minor unit', () => {
    expect(parseMoney('¥1,200', 'EUR')).toEqual({ minor: 1200, currency: 'JPY' });
  });

  it('reads a bare $ as the default currency when that is a dollar', () => {
    expect(parseMoney('$5.00', 'CAD')).toEqual({ minor: 500, currency: 'CAD' });
    expect(parseMoney('$5.00', 'EUR')).toEqual({ minor: 500, currency: 'USD' });
  });

  it.each(['', 'total', '€', '1234567890123456', '12.50.30,1'])('refuses %j', (raw) => {
    expect(parseMoney(raw, 'EUR')).toBeNull();
  });
});

suite('names', () => {
  it.each([
    ['ACME Ltd.', 'acme'],
    ['Acme Limited', 'acme'],
    ['ＡＣＭＥ GmbH', 'acme'],
    ['Mr. D.I.Y. (M) Sdn Bhd', 'mr d i y m'],
    ['  Cinema   City, Inc  ', 'cinema city'],
    ['Ltd', 'ltd'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normaliseName(raw)).toBe(expected);
  });

  it('scores identical names 1 and unrelated names low', () => {
    expect(similarity('ACME Ltd', 'Acme')).toBe(1);
    expect(similarity('Acme', 'Zebra Foods')).toBeLessThan(0.5);
    expect(similarity('', '')).toBe(1);
  });

  it('matches a known name despite a typo, and nothing when no name is close', () => {
    const known = ['Cinema City', 'City Power', 'ACME'];
    expect(matchVocabulary('CINEMA CTY SDN BHD', known)).toBe('Cinema City');
    expect(matchVocabulary('Acme Limited', known)).toBe('ACME');
    expect(matchVocabulary('Water Board', known)).toBeNull();
    expect(matchVocabulary('anything', [])).toBeNull();
  });
});
