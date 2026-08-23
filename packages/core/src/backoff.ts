/**
 * Retry schedule. Pure: jitter is supplied by the caller (Math.random in the app,
 * a seeded PRNG in the simulator) so a replayed log always produces the same times.
 */

/** Delay before attempt N+1, given that attempt N just failed. Index 0 is unused. */
const LADDER_MS = [0, 2_000, 5_000, 15_000, 60_000] as const;
const CAP_MS = 300_000;

/** Automatic attempts before we stop and ask the user. The document is never dropped. */
export const MAX_AUTO_ATTEMPTS = 5;

/**
 * Equal jitter: half the delay is fixed, half is spread. Prevents a fleet of
 * queued documents from thundering at a just-recovered server.
 *
 * @param failedAttempt 1-based number of the attempt that just failed.
 * @param jitter Value in [0, 1).
 */
export function backoffMs(failedAttempt: number, jitter: number): number {
  const base = LADDER_MS[failedAttempt] ?? CAP_MS;
  return Math.round(base / 2 + jitter * (base / 2));
}

/** How long to wait before polling an accepted-but-unresolved task again. */
export function taskPollDelayMs(poll: number, jitter: number): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, poll - 1), 30_000);
  return Math.round(base / 2 + jitter * (base / 2));
}
