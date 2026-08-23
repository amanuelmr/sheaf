/**
 * Deterministic simulation testing for the sync engine.
 *
 * Instead of hand-writing the edge cases from the spec, we run the engine through
 * hundreds of seeded fault schedules — dropped requests, lost responses, 5xx, 401,
 * rate limits, offline windows, and process kills at arbitrary points — and assert
 * the properties that must hold across all of them.
 *
 * Every seed is reproducible: a failure names the exact schedule that broke it.
 */
import { describe as suite, expect, it } from 'vitest';
import { runSim, seeds, type SimResult } from '../src/sim';
import { CALM, FLAKY, HOSTILE } from '../src/faults';

function assertHealthy(result: SimResult, seed: number, documents: number): void {
  const where = `seed ${seed}`;

  // The engine never breaks its own invariants.
  expect(result.violations, `${where}: ${result.violations.join('; ')}`).toEqual([]);

  // Everything captured is eventually on the server. Nothing is lost.
  expect(result.converged, `${where}: did not converge in ${result.steps} steps`).toBe(true);
  expect(result.server.storedCount, `${where}: wrong document count`).toBe(documents);

  for (const [docId, state] of result.states) {
    expect(state.status, `${where}: ${docId}`).toBe('SYNCED');
    expect(result.server.has(state.sha256), `${where}: ${docId} missing on server`).toBe(true);
  }
}

suite('convergence under faults', () => {
  it('delivers every document through a hostile network, over many schedules', () => {
    for (const seed of seeds(150)) {
      const result = runSim({ seed, documents: 5, faults: HOSTILE });
      assertHealthy(result, seed, 5);
    }
  });

  it('delivers every document on a merely flaky network', () => {
    for (const seed of seeds(150, 1_000)) {
      const result = runSim({ seed, documents: 5, faults: FLAKY });
      assertHealthy(result, seed, 5);
    }
  });

  it('handles the ten-document batch from the acceptance scenario', () => {
    for (const seed of seeds(40, 5_000)) {
      const result = runSim({ seed, documents: 10, faults: HOSTILE });
      assertHealthy(result, seed, 10);
    }
  });

  it('does the obvious thing when nothing goes wrong', () => {
    const result = runSim({ seed: 1, documents: 3, faults: CALM });
    assertHealthy(result, 1, 3);
    // One POST per document, and no recovery machinery needed.
    expect(result.server.counters.posts).toBe(3);
    expect(result.server.counters.duplicatesReported).toBe(0);
    expect(result.reconciles).toBe(0);
    expect([...result.uploads.values()]).toEqual([1, 1, 1]);
  });
});

suite('exactly-once delivery', () => {
  it('stores one document per distinct content hash, however many times it is sent', () => {
    for (const seed of seeds(60, 20_000)) {
      const result = runSim({ seed, documents: 4, faults: HOSTILE });
      expect(result.server.storedCount, `seed ${seed}`).toBe(4);
      // Retries and lost responses mean more POSTs than documents; the server's
      // content hashing collapses them, and the client reads that as success.
      expect(result.server.counters.posts).toBeGreaterThanOrEqual(4);
      expect(result.server.counters.stored).toBe(4);
    }
  });

  it('actually exercises the lost-response and duplicate paths', () => {
    let duplicates = 0;
    let reconciles = 0;
    let kills = 0;
    for (const seed of seeds(60, 30_000)) {
      const result = runSim({ seed, documents: 4, faults: HOSTILE });
      duplicates += result.server.counters.duplicatesReported;
      reconciles += result.reconciles;
      kills += result.kills;
    }
    // Guards against the suite quietly passing because nothing interesting happened.
    expect(duplicates, 'no duplicate rejection was ever exercised').toBeGreaterThan(0);
    expect(reconciles, 'no crash recovery was ever exercised').toBeGreaterThan(0);
    expect(kills, 'no process kill was ever exercised').toBeGreaterThan(0);
  });

  it('never re-uploads a document it can find on the server', () => {
    // A kill mid-upload must be resolved by one hash lookup, not another POST.
    for (const seed of seeds(40, 40_000)) {
      const result = runSim({ seed, documents: 3, faults: HOSTILE });
      expect(result.violations, `seed ${seed}`).toEqual([]);
    }
  });
});

suite('determinism', () => {
  it('replays a seed identically', () => {
    const a = runSim({ seed: 777, documents: 6, faults: HOSTILE });
    const b = runSim({ seed: 777, documents: 6, faults: HOSTILE });
    expect(b.steps).toBe(a.steps);
    expect(b.reconciles).toBe(a.reconciles);
    expect(b.kills).toBe(a.kills);
    expect([...b.logs.values()]).toEqual([...a.logs.values()]);
    expect(b.server.snapshot()).toEqual(a.server.snapshot());
  });

  it('explores different schedules for different seeds', () => {
    const shapes = new Set(
      seeds(30, 900).map((seed) => {
        const r = runSim({ seed, documents: 4, faults: HOSTILE });
        return `${r.steps}:${r.reconciles}:${r.kills}:${r.server.counters.posts}`;
      }),
    );
    expect(shapes.size).toBeGreaterThan(10);
  });
});

suite('policy', () => {
  it('still converges when uploads are restricted to Wi-Fi', () => {
    for (const seed of seeds(40, 60_000)) {
      const result = runSim({
        seed,
        documents: 4,
        faults: FLAKY,
        policy: { wifiOnly: true, keepLocalAfterSync: true },
      });
      assertHealthy(result, seed, 4);
    }
  });

  it('releases local copies only after confirmation when retention allows it', () => {
    for (const seed of seeds(30, 70_000)) {
      const result = runSim({
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
