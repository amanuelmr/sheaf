/**
 * Properties of the second hop, over many schedules.
 *
 * The claim being tested is the one the product makes: a capture is safe once it
 * has been uploaded, and what happens after that is the server's problem. So the
 * questions are whether every document eventually arrives, whether any arrives
 * twice, and whether a hand-off going wrong can ever damage the document itself.
 *
 * Each seed is reproducible; a failure names the schedule that produced it.
 */
import { describe as suite, expect, it } from 'vitest';
import {
  FORWARD_FLAKY,
  FORWARD_HOSTILE,
  forwardSeeds,
  runForwardSim,
  type ForwardSimResult,
} from './forward-sim';

function assertHealthy(result: ForwardSimResult, seed: number, documents: number): void {
  const where = `seed ${seed}`;
  expect(result.violations, `${where}: ${result.violations.join('; ')}`).toEqual([]);
  expect(result.converged, `${where}: did not converge in ${result.steps} steps`).toBe(true);
  expect(result.records, `${where}: wrong document count`).toHaveLength(documents);
  // The invariant with teeth: more sends than documents is fine and expected, but
  // the target must end up holding exactly one copy of each.
  expect(result.paperless.counters.duplicateDocuments, `${where}: duplicated on the target`).toBe(
    0,
  );
}

suite('forwarding under faults', () => {
  it('hands on every document through a flaky target, over many schedules', async () => {
    for (const seed of forwardSeeds(40)) {
      assertHealthy(await runForwardSim({ seed, documents: 4, faults: FORWARD_FLAKY }), seed, 4);
    }
  });

  it('hands on every document through a hostile one', async () => {
    for (const seed of forwardSeeds(40, 2_000)) {
      assertHealthy(await runForwardSim({ seed, documents: 4, faults: FORWARD_HOSTILE }), seed, 4);
    }
  });

  it('actually exercises crashing mid-hand-off and losing the reply', async () => {
    let crashes = 0;
    let lost = 0;
    let sends = 0;
    let documents = 0;
    let adoptions = 0;
    for (const seed of forwardSeeds(40, 2_000)) {
      const result = await runForwardSim({ seed, documents: 4, faults: FORWARD_HOSTILE });
      crashes += result.crashes;
      lost += result.lostResponses;
      sends += result.sends;
      documents += result.records.length;
      adoptions += result.paperless.counters.taskLookups;
    }
    // Guards against the suite passing because nothing interesting happened.
    expect(crashes, 'the process never died mid-hand-off').toBeGreaterThan(0);
    expect(lost, 'a reply was never lost after the target accepted the bytes').toBeGreaterThan(0);
    expect(sends, 'no document was ever sent more than once').toBeGreaterThan(documents);
    // The recovery this exists for: asking the target what it already has in flight.
    expect(adoptions, 'an unresolved hand-off was never resolved by asking').toBeGreaterThan(0);
  });
});

suite('the document itself is never at risk', () => {
  it('keeps the stored bytes intact whatever the hand-off does', async () => {
    for (const seed of forwardSeeds(20, 5_000)) {
      const result = await runForwardSim({ seed, documents: 3, faults: FORWARD_HOSTILE });
      // Checked inside the simulator against the original payloads, so a corrupted
      // or missing object shows up here as a violation rather than as a pass.
      expect(result.violations, `seed ${seed}`).toEqual([]);
    }
  });
});

suite('determinism', () => {
  it('replays a seed identically', async () => {
    const a = await runForwardSim({ seed: 4_242, documents: 5, faults: FORWARD_HOSTILE });
    const b = await runForwardSim({ seed: 4_242, documents: 5, faults: FORWARD_HOSTILE });
    expect(b.steps).toBe(a.steps);
    expect(b.sends).toBe(a.sends);
    expect(b.crashes).toBe(a.crashes);
    expect(b.paperless.snapshot()).toEqual(a.paperless.snapshot());
  });

  it('explores different schedules for different seeds', async () => {
    const shapes = new Set<string>();
    for (const seed of forwardSeeds(20, 900)) {
      const r = await runForwardSim({ seed, documents: 3, faults: FORWARD_HOSTILE });
      shapes.add(`${r.steps}:${r.sends}:${r.crashes}:${r.lostResponses}`);
    }
    expect(shapes.size).toBeGreaterThan(6);
  });
});
