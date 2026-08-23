import { describe as suite, expect, it } from 'vitest';
import { MAX_AUTO_ATTEMPTS, backoffMs, taskPollDelayMs } from '../src/backoff';

suite('backoffMs', () => {
  it('follows the ladder, with half the delay jittered', () => {
    expect(backoffMs(1, 0)).toBe(1_000);
    expect(backoffMs(1, 0.999)).toBeCloseTo(2_000, -1);
    expect(backoffMs(2, 0)).toBe(2_500);
    expect(backoffMs(3, 0)).toBe(7_500);
    expect(backoffMs(4, 0)).toBe(30_000);
  });

  it('caps beyond the ladder instead of growing without bound', () => {
    expect(backoffMs(MAX_AUTO_ATTEMPTS, 0)).toBe(150_000);
    expect(backoffMs(50, 1)).toBeLessThanOrEqual(300_000);
  });

  it('is monotonic in jitter and never below half the rung', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const low = backoffMs(attempt, 0);
      const high = backoffMs(attempt, 0.99);
      expect(high).toBeGreaterThanOrEqual(low);
      expect(low).toBeGreaterThan(0);
    }
  });
});

suite('taskPollDelayMs', () => {
  it('backs off polling but stays responsive', () => {
    expect(taskPollDelayMs(1, 0)).toBe(500);
    expect(taskPollDelayMs(2, 0)).toBe(1_000);
    expect(taskPollDelayMs(99, 1)).toBeLessThanOrEqual(30_000);
  });
});
