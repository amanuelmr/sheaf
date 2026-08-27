export type { Rng } from './random.ts';
export { rng } from './random.ts';
export type { VirtualClock } from './clock.ts';
export { virtualClock } from './clock.ts';
export type { ServerCounters, StoredDocument } from './fake-sheaf.ts';
export { FakeSheaf } from './fake-sheaf.ts';
// Paperless is no longer anything the phone talks to -- but it is still what the
// *server* forwards to, so this moved rather than died. It models the target's
// semantics for the forwarder simulation.
export type {
  ServerCounters as PaperlessCounters,
  StoredDocument as PaperlessDocument,
} from './fake-paperless.ts';
export { FakePaperless } from './fake-paperless.ts';
export type { AttemptFault, FaultProfile } from './faults.ts';
export {
  CALM,
  FLAKY,
  HOSTILE,
  rollAttempt,
  rollKill,
  rollOffline,
  rollSideTask,
} from './faults.ts';
export type { SimOptions, SimResult } from './sim.ts';
export { runSim, seeds } from './sim.ts';
