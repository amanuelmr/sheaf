import { describe as suite, expect, it } from 'vitest';
import { formatBytes, pageLabel, retryIn, shortId, timeAgo } from '../src/lib/format';

const NOW = 1_700_000_000_000;

suite('timeAgo', () => {
  it('reads the way a person would say it', () => {
    expect(timeAgo(NOW, NOW)).toBe('just now');
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(timeAgo(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
    expect(timeAgo(NOW - 5 * 60 * 60_000, NOW)).toBe('5 hours ago');
    expect(timeAgo(NOW - 26 * 60 * 60_000, NOW)).toBe('yesterday');
    expect(timeAgo(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3 days ago');
  });

  it('does not show a negative age when the device clock has moved back', () => {
    expect(timeAgo(NOW + 60_000, NOW)).toBe('just now');
  });
});

suite('formatBytes', () => {
  it('never shows more precision than is useful', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(940)).toBe('940 B');
    expect(formatBytes(12_400)).toBe('12 kB');
    expect(formatBytes(1_240_000)).toBe('1.2 MB');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

suite('pageLabel', () => {
  it('gets the plural right', () => {
    expect(pageLabel(1)).toBe('1 page');
    expect(pageLabel(4)).toBe('4 pages');
    expect(pageLabel(0)).toBe('0 pages');
  });
});

suite('retryIn', () => {
  it('says when, in units a person cares about', () => {
    expect(retryIn(null, NOW)).toBeNull();
    expect(retryIn(NOW - 1, NOW)).toBe('trying again now');
    expect(retryIn(NOW + 12_000, NOW)).toBe('trying again in 12s');
    expect(retryIn(NOW + 90_000, NOW)).toBe('trying again in 2 min');
  });
});

suite('shortId', () => {
  it('shortens a hash to something a person can compare', () => {
    expect(shortId('a'.repeat(64))).toBe('aaaaaaaa');
  });
});
