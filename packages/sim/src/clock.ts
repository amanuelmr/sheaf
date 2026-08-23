/**
 * A virtual clock. Time only moves when the simulation says so, which is why ten
 * thousand fault schedules spanning simulated hours run in seconds of real time.
 */
export interface VirtualClock {
  now(): number;
  advance(ms: number): void;
  /** Jump forward, as a device waking from sleep or a user's clock resyncing does. */
  jump(ms: number): void;
}

export function virtualClock(startMs = 1_700_000_000_000): VirtualClock {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => {
      if (ms < 0) throw new Error('advance must move forward');
      t += ms;
    },
    jump: (ms) => {
      t += ms;
    },
  };
}
