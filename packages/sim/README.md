# @sheaf/sim

Deterministic simulation testing for the sync engine, in the FoundationDB /
TigerBeetle style: virtual time, seeded randomness, injected faults.

Present: the two primitives everything else is built on — a seeded PRNG and a
virtual clock.

Next: the fault-injecting fake Paperless server and the scenario runner, so we can
assert over thousands of schedules that no document is ever lost or duplicated:

```ts
for (const seed of seeds(10_000)) {
  const sim = new Sim(seed); // drops, 5xx, 401s, timeouts, duplicate replies,
  // clock jumps, process kills at any step, disk-full
  sim.run(scenarios.tenDocuments);
  assert(sim.server.documents.length === 10); // no loss
  assert(noDuplicates(sim.server.documents)); // no dupes
}
```

A failing seed replays exactly, so a distributed-systems bug becomes a laptop bug.
