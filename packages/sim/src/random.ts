/**
 * mulberry32 — small, fast, and fully determined by its seed.
 *
 * Every source of nondeterminism in the simulator comes from here, so a failing
 * seed is a reproducible bug rather than a story about a flaky test.
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [0, boundExclusive). */
  int(boundExclusive: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (bound) => Math.floor(next() * bound),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
