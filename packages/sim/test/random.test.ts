import { describe as suite, expect, it } from 'vitest';
import { rng } from '../src/random';
import { virtualClock } from '../src/clock';

suite('rng', () => {
  it('is fully reproducible from its seed', () => {
    const a = rng(42);
    const b = rng(42);
    const drawA = Array.from({ length: 50 }, () => a.next());
    const drawB = Array.from({ length: 50 }, () => b.next());
    expect(drawA).toEqual(drawB);
  });

  it('produces different streams for different seeds', () => {
    expect(rng(1).next()).not.toBe(rng(2).next());
  });

  it('stays inside its bounds', () => {
    const r = rng(7);
    for (let i = 0; i < 1_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(r.int(10)).toBeLessThan(10);
    }
  });

  it('refuses to pick from nothing rather than returning undefined', () => {
    expect(() => rng(1).pick([])).toThrow();
  });
});

suite('virtualClock', () => {
  it('only moves when told to', () => {
    const clock = virtualClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    expect(() => clock.advance(-1)).toThrow();
  });
});
