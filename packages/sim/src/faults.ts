import type { Rng } from './random';

/**
 * What can go wrong, as per-attempt probabilities.
 *
 * `lostResponse` is the important one: the server accepts the document and the
 * client never learns the task id. Naive uploaders create a duplicate here, or
 * declare failure on a document that is safely stored.
 */
export interface FaultProfile {
  /** The device has no usable connection this tick. */
  readonly offline: number;
  /** The request never reaches the server. */
  readonly dropRequest: number;
  /** The server accepted it; the reply was lost. */
  readonly lostResponse: number;
  readonly serverError: number;
  /** Token rejected — needs the user, not a retry. */
  readonly authError: number;
  readonly rateLimited: number;
  /** The process dies and comes back, forcing a resume. */
  readonly kill: number;
  /**
   * Post-sync work fails: suggestions or a metadata patch.
   *
   * Added after a probe found the engine re-asking a 404 suggestions endpoint on
   * every tick for ever. The simulator never caught it because its ports always
   * answered `ok`, so this path did not exist here either.
   */
  readonly sideTaskError: number;
  /** Virtual time after which the world behaves. Convergence is asserted past it. */
  readonly healAtMs: number;
}

export const HOSTILE: FaultProfile = {
  offline: 0.3,
  dropRequest: 0.25,
  lostResponse: 0.2,
  serverError: 0.15,
  authError: 0.05,
  rateLimited: 0.1,
  kill: 0.08,
  sideTaskError: 0.35,
  healAtMs: 120_000,
};

export const FLAKY: FaultProfile = {
  offline: 0.15,
  dropRequest: 0.1,
  lostResponse: 0.1,
  serverError: 0.05,
  authError: 0,
  rateLimited: 0.05,
  kill: 0.03,
  sideTaskError: 0.15,
  healAtMs: 60_000,
};

export const CALM: FaultProfile = {
  offline: 0,
  dropRequest: 0,
  lostResponse: 0,
  serverError: 0,
  authError: 0,
  rateLimited: 0,
  kill: 0,
  sideTaskError: 0,
  healAtMs: 0,
};

/** What the network did to one upload attempt. */
export type AttemptFault =
  'none' | 'dropRequest' | 'lostResponse' | 'serverError' | 'authError' | 'rateLimited';

export function rollAttempt(profile: FaultProfile, rng: Rng, now: number): AttemptFault {
  if (now >= profile.healAtMs) return 'none';
  if (rng.chance(profile.dropRequest)) return 'dropRequest';
  if (rng.chance(profile.lostResponse)) return 'lostResponse';
  if (rng.chance(profile.serverError)) return 'serverError';
  if (rng.chance(profile.authError)) return 'authError';
  if (rng.chance(profile.rateLimited)) return 'rateLimited';
  return 'none';
}

export function rollOffline(profile: FaultProfile, rng: Rng, now: number): boolean {
  return now < profile.healAtMs && rng.chance(profile.offline);
}

export function rollKill(profile: FaultProfile, rng: Rng, now: number): boolean {
  return now < profile.healAtMs && rng.chance(profile.kill);
}

/**
 * Side-task faults do NOT heal. A server without a suggestions endpoint never grows
 * one, and that permanence is the whole point: the engine must stop asking.
 */
export function rollSideTask(profile: FaultProfile, rng: Rng): 'ok' | 'transient' | 'permanent' {
  if (!rng.chance(profile.sideTaskError)) return 'ok';
  return rng.chance(0.5) ? 'permanent' : 'transient';
}
