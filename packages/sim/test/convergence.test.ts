/**
 * Deterministic simulation testing for the sync engine.
 *
 * The engine under test is the real one — `@sheaf/engine` writing to a real
 * `DocumentStore`. Only the world is simulated: the clock is virtual, randomness
 * is seeded, and the faults live in the ports. So these properties are claims
 * about shipping code, not about a copy of it.
 *
 * Every seed is reproducible: a failure names the exact schedule that broke it.
 *
 * The simulated world is our own ingestion server, which is the point: an engine
 * proved correct against a protocol it no longer speaks has been proved nothing.
 */
import { describe as suite, expect, it } from 'vitest';
import { runSim, seeds, type SimResult } from '../src/sim';
import { MAX_AUTO_ATTEMPTS } from '@sheaf/core';
import { CALM, FLAKY, HOSTILE } from '../src/faults';

function assertHealthy(result: SimResult, seed: number, documents: number): void {
  const where = `seed ${seed}`;

  expect(result.violations, `${where}: ${result.violations.join('; ')}`).toEqual([]);
  expect(result.converged, `${where}: did not converge in ${result.steps} steps`).toBe(true);
  expect(result.server.storedCount, `${where}: wrong document count`).toBe(documents);

  for (const [docId, state] of result.states) {
    expect(state.status, `${where}: ${docId}`).toBe('SYNCED');
    expect(result.server.has(state.sha256), `${where}: ${docId} missing on server`).toBe(true);
  }
}

suite('convergence under faults', () => {
  it('delivers every document through a hostile network, over many schedules', async () => {
    for (const seed of seeds(120)) {
      assertHealthy(await runSim({ seed, documents: 5, faults: HOSTILE }), seed, 5);
    }
  });

  it('delivers every document on a merely flaky network', async () => {
    for (const seed of seeds(120, 1_000)) {
      assertHealthy(await runSim({ seed, documents: 5, faults: FLAKY }), seed, 5);
    }
  });

  it('handles the ten-document batch from the acceptance scenario', async () => {
    for (const seed of seeds(30, 5_000)) {
      assertHealthy(await runSim({ seed, documents: 10, faults: HOSTILE }), seed, 10);
    }
  });

  it('does the obvious thing when nothing goes wrong', async () => {
    const result = await runSim({ seed: 1, documents: 3, faults: CALM });
    assertHealthy(result, 1, 3);
    // One PUT per document, and no recovery machinery needed.
    expect(result.server.counters.puts).toBe(3);
    expect(result.server.counters.duplicates).toBe(0);
    expect(result.server.counters.headLookups).toBe(0);
    expect(result.reconciles).toBe(0);
    expect([...result.uploads.values()]).toEqual([1, 1, 1]);
  });
});

suite('exactly-once delivery', () => {
  it('stores one document per distinct content hash, however many times it is sent', async () => {
    for (const seed of seeds(50, 20_000)) {
      const result = await runSim({ seed, documents: 4, faults: HOSTILE });
      expect(result.server.storedCount, `seed ${seed}`).toBe(4);
      // Sent more often than stored -- and stored exactly as many times as there
      // are distinct documents. That gap is retries; that equality is the guarantee.
      expect(result.server.counters.puts).toBeGreaterThanOrEqual(4);
      expect(result.server.counters.stored).toBe(4);
    }
  });

  it('actually exercises the lost-response and crash paths', async () => {
    let duplicates = 0;
    let reconciles = 0;
    let kills = 0;
    let patches = 0;
    let abandoned = 0;
    for (const seed of seeds(50, 30_000)) {
      const result = await runSim({ seed, documents: 4, faults: HOSTILE });
      for (const state of result.states.values()) {
        if (state.side.suggestions.abandoned !== null) abandoned += 1;
        if (state.side.metadata.abandoned !== null) abandoned += 1;
      }
      duplicates += result.server.counters.duplicates;
      reconciles += result.reconciles;
      kills += result.kills;
      patches += result.server.counters.patches;
    }
    // Guards against the suite quietly passing because nothing interesting happened.
    expect(duplicates, 're-sending known bytes was never exercised').toBeGreaterThan(0);
    expect(abandoned, 'post-sync work was never given up on').toBeGreaterThan(0);
    expect(reconciles, 'no crash recovery was ever exercised').toBeGreaterThan(0);
    expect(kills, 'no process kill was ever exercised').toBeGreaterThan(0);
    expect(patches, 'metadata was never patched').toBeGreaterThan(0);
  });

  it('bounds post-sync work instead of asking for ever', async () => {
    // A server with nothing to suggest never grows an opinion, and a patch that is
    // refused stays refused. The engine has to notice and stop -- it did not, and
    // asked 198 times in 200 ticks.
    for (const seed of seeds(40, 80_000)) {
      const result = await runSim({ seed, documents: 5, faults: HOSTILE });
      // At most one budget per task per document, plus the successes.
      const ceiling = 5 * 2 * (MAX_AUTO_ATTEMPTS + 1);
      expect(
        result.sideTaskCalls,
        `seed ${seed}: ${result.sideTaskCalls} calls`,
      ).toBeLessThanOrEqual(ceiling);
      expect(result.converged, `seed ${seed}`).toBe(true);
    }
  });

  it('never uploads while the server might already hold the document', async () => {
    for (const seed of seeds(40, 40_000)) {
      const result = await runSim({ seed, documents: 3, faults: HOSTILE });
      expect(result.violations, `seed ${seed}`).toEqual([]);
    }
  });
});

suite('determinism', () => {
  it('replays a seed identically', async () => {
    const a = await runSim({ seed: 777, documents: 6, faults: HOSTILE });
    const b = await runSim({ seed: 777, documents: 6, faults: HOSTILE });
    expect(b.steps).toBe(a.steps);
    expect(b.reconciles).toBe(a.reconciles);
    expect(b.kills).toBe(a.kills);
    expect(await b.log.since(0)).toEqual(await a.log.since(0));
    expect(b.server.snapshot()).toEqual(a.server.snapshot());
  });

  it('explores different schedules for different seeds', async () => {
    const shapes = new Set<string>();
    for (const seed of seeds(25, 900)) {
      const r = await runSim({ seed, documents: 4, faults: HOSTILE });
      shapes.add(`${r.steps}:${r.reconciles}:${r.kills}:${r.server.counters.puts}`);
    }
    expect(shapes.size).toBeGreaterThan(8);
  });
});

suite('policy', () => {
  it('still converges when uploads are restricted to Wi-Fi', async () => {
    for (const seed of seeds(30, 60_000)) {
      const result = await runSim({
        seed,
        documents: 4,
        faults: FLAKY,
        policy: { wifiOnly: true, keepLocalAfterSync: true },
      });
      assertHealthy(result, seed, 4);
    }
  });

  it('releases local copies only after confirmation when retention allows it', async () => {
    for (const seed of seeds(25, 70_000)) {
      const result = await runSim({
        seed,
        documents: 4,
        faults: HOSTILE,
        policy: { wifiOnly: false, keepLocalAfterSync: false },
      });
      assertHealthy(result, seed, 4);
      for (const state of result.states.values()) {
        expect(state.localFilesPresent).toBe(false);
        expect(result.server.has(state.sha256)).toBe(true);
      }
    }
  });
});
