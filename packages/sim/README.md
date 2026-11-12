# @sheaf/sim

Deterministic simulation testing for the sync engine, in the FoundationDB /
TigerBeetle style: virtual time, seeded randomness, injected faults.

Rather than hand-writing the edge cases from the spec, the suite runs the **real**
engine — `@sheaf/engine` writing to a real `DocumentStore` — through hundreds of
seeded fault schedules, and asserts the properties that must hold across all of
them. Only the world is simulated: the clock is virtual, randomness is seeded, and
the faults live in the ports.

```ts
for (const seed of seeds(150)) {
  const result = runSim({ seed, documents: 5, faults: HOSTILE });
  expect(result.violations).toEqual([]); // no invariant broken
  expect(result.converged).toBe(true); // everything arrived
  expect(result.server.storedCount).toBe(5); // exactly once
}
```

## What gets injected

| Fault          | Models                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `offline`      | no usable connection this tick                                                          |
| `dropRequest`  | the request never reaches the server                                                    |
| `lostResponse` | **the server stored it and the reply was lost**                                         |
| `serverError`  | 5xx                                                                                     |
| `authError`    | 401 — needs the user, not a retry                                                       |
| `rateLimited`  | 429, with `Retry-After`                                                                 |
| `kill`         | the process dies, including _between_ logging an upload attempt and logging its outcome |

`lostResponse` and the mid-request `kill` are the ones that matter. Both leave the
client unable to tell "never arrived" from "arrived, reply lost" — the case that
makes naive uploaders either duplicate the document or declare failure on one that
is safely stored.

`sideTaskError` was added after the fact. The ports here used to answer `ok` for
suggestions and metadata patches, so the engine's behaviour when they fail was never
exercised at all — and it turned out to retry a permanent 404 on every tick, for
every synced document, indefinitely. Those faults deliberately do **not** heal: a
server without a suggestions endpoint never grows one, and the engine has to notice
and stop.

`FakeSheaf` models the server semantics the engine depends on: a `PUT` to a
document's own address answers at once, re-sending the same bytes reports
`already-stored` rather than making a second document, and `HEAD` answers "do you
hold this?" with a status code.

It replaced a `FakePaperless`, which modelled a server that consumes later, on its
own timeline, and reports duplicates through a task. An earlier version of that
fake resolved consumption lazily when a client polled, which quietly made the
duplicate path unreachable — the suite passed while testing nothing. The "actually
exercises the interesting paths" test exists to catch exactly that, and still runs.

## What the hostile schedules do

The last full count, recorded in the [project README](../../README.md#architecture):
300 hostile schedules covering 1,500 documents through the real engine, with 3,644
process kills, including kills _between_ logging an upload attempt and logging its
outcome. The engine sent 2,003 uploads, stored exactly 1,500 documents, read 490
duplicate answers as success, and recovered 255 interrupted uploads with a hash
lookup rather than a re-upload. Nothing lost, nothing duplicated.

Every number is reproducible: a failing seed replays exactly, so a
distributed-systems bug becomes a laptop bug.

## Still to come

Clock jumps (device sleep, NTP resync), disk-full on the local write path, and
the real server behind a fault-injecting proxy, to check the assumptions
`FakeSheaf` encodes.
