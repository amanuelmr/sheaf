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

`FakePaperless` models the server semantics the engine depends on: a POST returns a
task id immediately, consumption completes later **on the server's own timeline**
whether or not a client is watching, and content is hashed server-side so a
re-upload is refused as a duplicate.

That last detail is load-bearing. An earlier version of the fake resolved
consumption lazily when a client polled, which quietly made the duplicate path
unreachable — the suite passed while testing nothing. The "actually exercises the
interesting paths" test exists to catch exactly that.

## What 200 hostile schedules do

1,000 documents through the real engine:

```
events appended                9,986
POSTs issued                   1,327     retries and lost responses
documents stored               1,000     exactly one per content hash
duplicate rejections           324       each read as SYNCED, not as failure
crash recoveries               161       resolved by one hash lookup, never a re-upload
process kills survived         2,459
metadata patches applied       733
documents lost                 0
documents duplicated           0
```

Every number is reproducible: a failing seed replays exactly, so a
distributed-systems bug becomes a laptop bug.

## Still to come

Clock jumps (device sleep, NTP resync), disk-full on the local write path, and
contract tests against a real Paperless-ngx behind a fault-injecting proxy, to
validate the assumptions `FakePaperless` encodes.
