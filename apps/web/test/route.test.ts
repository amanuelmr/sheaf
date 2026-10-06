/**
 * The two places this app could be fooled by input it did not expect.
 *
 * A hash is the only user-controlled value that reaches a request path, and money
 * comes off the wire as an untyped amount. Both are cheap to pin down and
 * expensive to get wrong: a routing hole would fetch the wrong document, and a
 * formatting hole would render a wrong amount to someone deciding what to pay.
 */
import { describe as suite, expect, it } from 'vitest';
import { href, parse } from '../src/route';
import { money, shortSha } from '../src/format';

const SHA = 'a'.repeat(64);

suite('parse', () => {
  it('reads each page from the hash', () => {
    expect(parse('#/search')).toEqual({ page: 'search' });
    expect(parse('#/inbox')).toEqual({ page: 'inbox' });
    expect(parse('#/devices')).toEqual({ page: 'devices' });
    expect(parse('#/system')).toEqual({ page: 'system' });
    expect(parse(`#/doc/${SHA}`)).toEqual({ page: 'document', sha256: SHA });
  });

  it('falls back to search for anything it does not recognise', () => {
    for (const hash of ['', '#', '#/', '#/nope', '#/doc', '#/doc/short', '#/search/x']) {
      expect(parse(hash)).toEqual({ page: 'search' });
    }
  });

  it('refuses anything that is not exactly a sha256', () => {
    const lookalikes = [
      `#/doc/${SHA}extra`, // too long: a longer path must not match
      `#/doc/${SHA.toUpperCase()}`, // the server stores lowercase hex
      `#/doc/${'g'.repeat(64)}`, // not hex
      `#/doc/${'a'.repeat(63)}`, // too short
      '#/doc/../../etc/passwd',
      `#/doc/${SHA}%2F..`,
      `#/doc/"><img src=x>`,
    ];
    for (const hash of lookalikes) {
      expect(parse(hash)).toEqual({ page: 'search' });
    }
  });

  it('tolerates a hash with or without its leading #', () => {
    expect(parse(`/doc/${SHA}`)).toEqual({ page: 'document', sha256: SHA });
  });
});

suite('href', () => {
  it('round-trips every page', () => {
    expect(href({ page: 'search' })).toBe('#/search');
    expect(href({ page: 'inbox' })).toBe('#/inbox');
    expect(href({ page: 'devices' })).toBe('#/devices');
    expect(href({ page: 'system' })).toBe('#/system');
    expect(href({ page: 'document', sha256: SHA })).toBe(`#/doc/${SHA}`);
  });

  it('produces a hash parse accepts', () => {
    for (const page of ['search', 'inbox', 'devices', 'system'] as const) {
      const route = { page } as const;
      expect(parse(href(route))).toEqual(route);
    }
    const doc = { page: 'document', sha256: SHA } as const;
    expect(parse(href(doc))).toEqual(doc);
  });
});

suite('shortSha', () => {
  it('is enough to recognise a document and not enough to collide by eye', () => {
    expect(shortSha(SHA)).toHaveLength(8);
    expect(shortSha(SHA)).toBe('aaaaaaaa');
    expect(shortSha('b'.repeat(64))).not.toBe(shortSha(SHA));
  });
});

suite('money', () => {
  it('divides minor units by the currency own number of digits', () => {
    // 2 digits: 1234 minor units is 12.34.
    expect(money({ minor: 1234, currency: 'EUR' })).toContain('12.34');
    // 0 digits: JPY has no subunit, so 1234 minor units is 1234 yen.
    expect(money({ minor: 1234, currency: 'JPY' })).toContain('1,234');
  });

  it('renders nothing rather than a wrong amount for anything unexpected', () => {
    for (const value of [
      null,
      undefined,
      12.34,
      '12.34',
      {},
      { minor: 1234 }, // no currency
      { currency: 'EUR' }, // no amount
      { minor: '1234', currency: 'EUR' }, // amount as a string
      { minor: Number.NaN, currency: 'EUR' },
    ]) {
      expect(money(value)).toBeNull();
    }
  });

  it('falls back to plain text for a currency Intl does not know', () => {
    // An unknown code makes Intl.NumberFormat throw; showing the digits still beats
    // showing nothing, and showing "NaN" does not.
    const rendered = money({ minor: 1234, currency: 'XXXXX' });
    expect(rendered).not.toBeNull();
    expect(rendered).toContain('12.34');
  });
});
