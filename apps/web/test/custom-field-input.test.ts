/**
 * Turning what someone typed into a custom field value, and back. Money is the
 * case worth the care: a float round trip would store 28 cents for "0.29".
 */
import { describe as suite, expect, it } from 'vitest';
import { fromInput, toInput } from '../src/custom-field-input';

suite('fromInput', () => {
  it('reads empty text as a field with no value', () => {
    expect(fromInput('text', '   ')).toBeNull();
    expect(fromInput('monetary', '')).toBeNull();
  });

  it('parses amounts exactly, in the currency’s own minor units', () => {
    expect(fromInput('monetary', '0.29', 'EUR')).toEqual({ minor: 29, currency: 'EUR' });
    expect(fromInput('monetary', '12,5', 'EUR')).toEqual({ minor: 1250, currency: 'EUR' });
    expect(fromInput('monetary', '1500', 'JPY')).toEqual({ minor: 1500, currency: 'JPY' });
    expect(fromInput('monetary', '-3.10', 'USD')).toEqual({ minor: -310, currency: 'USD' });
  });

  it('gives currencies with three decimals their third digit', () => {
    expect(fromInput('monetary', '1.5', 'KWD')).toEqual({ minor: 1500, currency: 'KWD' });
    expect(fromInput('monetary', '0.125', 'BHD')).toEqual({ minor: 125, currency: 'BHD' });
    expect(toInput('monetary', { minor: 1500, currency: 'KWD' })).toBe('1.500');
  });

  it('refuses an amount with more precision than the currency has', () => {
    expect(fromInput('monetary', '1.234', 'EUR')).toBeUndefined();
    expect(fromInput('monetary', '1.5', 'JPY')).toBeUndefined();
    expect(fromInput('monetary', '12 euros', 'EUR')).toBeUndefined();
  });

  it('reads whole numbers and numbers strictly', () => {
    expect(fromInput('integer', '42')).toBe(42);
    expect(fromInput('integer', '4.2')).toBeUndefined();
    expect(fromInput('number', '4.25')).toBe(4.25);
    expect(fromInput('number', '4e5')).toBeUndefined();
  });

  it('reads yes/no and a list of linked documents', () => {
    expect(fromInput('boolean', 'true')).toBe(true);
    expect(fromInput('boolean', 'maybe')).toBeUndefined();
    expect(fromInput('documentLink', ' a , b ,')).toEqual(['a', 'b']);
  });
});

suite('toInput', () => {
  it('shows an amount with the currency’s digits, and round-trips it', () => {
    expect(toInput('monetary', { minor: 29, currency: 'EUR' })).toBe('0.29');
    expect(toInput('monetary', { minor: 1500, currency: 'JPY' })).toBe('1500');
    const value = { minor: 123456, currency: 'EUR' };
    expect(fromInput('monetary', toInput('monetary', value), 'EUR')).toEqual(value);
  });

  it('shows nothing for no value', () => {
    expect(toInput('date', null)).toBe('');
  });
});
