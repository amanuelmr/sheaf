/**
 * Deterministic simulation for the job runner, built the same way as
 * `forward-sim.ts`: the real `JobRunner` over real `Storage`, a virtual clock, a
 * seeded random stream, and steps that fail and crash on purpose.
 *
 * The crash that matters most is the one after a step has done its work but before
 * the runner wrote that down. Hand-written tests rarely cover that moment, and it is
 * the reason steps must be idempotent: the work will be done again.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { err, ok, type ApiResult } from '@sheaf/http';
import { rng, virtualClock, type Rng } from '@sheaf/sim';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { JobRunner, type Step } from '../src/jobs';
import { Storage, sha256Hex } from '../src/storage';

const SEEDS = 200;
const DOCUMENTS = 8;
const MAX_TICKS = 2_000;
const TICK_MS = 5_000;

interface World {
  readonly driver: NodeSqliteDriver;
  /** What each step left behind, by `sha256:step`. Writing it twice is harmless. */
  readonly effects: Map<string, string>;
  /** Every time a step started, and whether what it depends on had finished. */
  readonly violations: string[];
  crashes: number;
}

function chaoticStep(name: string, after: readonly string[], world: World, random: Rng): Step {
  return {
    name,
    version: 1,
    after,
    budget: 6,
    applies: () => Promise.resolve(true),
    run: async (document): Promise<ApiResult<null>> => {
      for (const prerequisite of after) {
        if (!world.effects.has(`${document.sha256}:${prerequisite}`)) {
          const rows = await world.driver.all<{ state: string }>(
            'SELECT state FROM jobs WHERE sha256 = ? AND step = ?',
            [document.sha256, prerequisite],
          );
          if (rows[0]?.state !== 'given_up') {
            world.violations.push(`${name} ran before ${prerequisite} for ${document.sha256}`);
          }
        }
      }

      const roll = random.next();
      if (roll < 0.05) {
        world.crashes += 1;
        throw new Error('killed before doing anything');
      }
      if (roll < 0.15) return err({ kind: 'unreachable' });
      if (roll < 0.17) return err({ kind: 'rejected', status: 400, message: 'refused' });

      world.effects.set(`${document.sha256}:${name}`, `${name}(${document.sha256})`);
      if (roll < 0.25) {
        world.crashes += 1;
        throw new Error('killed after the work, before it was recorded');
      }
      return ok(null);
    },
  };
}

async function simulate(seed: number): Promise<{
  world: World;
  states: readonly { sha256: string; step: string; state: string }[];
  converged: boolean;
}> {
  const random = rng(seed);
  const clock = virtualClock();
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-jobsim-')),
  });
  const world: World = { driver, effects: new Map(), violations: [], crashes: 0 };
  const steps = [
    chaoticStep('ocr', [], world, random),
    chaoticStep('extract', ['ocr'], world, random),
  ];

  for (let i = 0; i < DOCUMENTS; i++) {
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\nseed ${seed} doc ${i}\n%%EOF\n`));
    await storage.put(sha256Hex(bytes), bytes, clock.now(), 1);
  }

  const terminal = async (): Promise<boolean> => {
    const rows = await driver.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs WHERE state IN ('done', 'skipped', 'given_up')`,
    );
    return (rows[0]?.n ?? 0) === DOCUMENTS * steps.length;
  };

  const ports = { now: () => clock.now(), jitter: () => random.next() };
  let runner = new JobRunner(driver, storage, steps, ports);
  let converged = false;
  for (let tick = 0; tick < MAX_TICKS && !converged; tick++) {
    try {
      await runner.tick();
    } catch {
      // The process died. A new one starts with nothing in memory but the database.
      runner = new JobRunner(driver, storage, steps, ports);
    }
    clock.advance(TICK_MS);
    converged = await terminal();
  }

  const states = await driver.all<{ sha256: string; step: string; state: string }>(
    'SELECT sha256, step, state FROM jobs',
  );
  return { world, states, converged };
}

suite('job runner under faults', () => {
  it(`converges across ${String(SEEDS)} seeds, in order, and never loses finished work`, async () => {
    let crashes = 0;
    let givenUp = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { world, states, converged } = await simulate(seed);
      crashes += world.crashes;

      expect(converged, `seed ${String(seed)} did not converge`).toBe(true);
      expect(world.violations, `seed ${String(seed)}`).toEqual([]);
      for (const row of states) {
        if (row.state === 'done') {
          expect(world.effects.has(`${row.sha256}:${row.step}`), `seed ${String(seed)}`).toBe(true);
        }
        if (row.state === 'given_up') givenUp += 1;
      }
    }
    // The faults must actually have happened, or this proves nothing.
    expect(crashes).toBeGreaterThan(SEEDS);
    expect(givenUp).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed gives the same outcome', async () => {
    const a = await simulate(42);
    const b = await simulate(42);
    const key = (rows: readonly { sha256: string; step: string; state: string }[]): string[] =>
      rows.map((r) => `${r.step}:${r.state}`).sort();
    expect(key(a.states)).toEqual(key(b.states));
    expect(a.world.crashes).toBe(b.world.crashes);
  });
});
