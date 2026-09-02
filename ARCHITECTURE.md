# Architecture

## Layers

```
                    ┌─────────────────────────────────┐
                    │          apps/mobile            │
                    │  camera · screens · adapters    │
                    │  (all effects live here)        │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │        packages/engine          │
                    │  command → effect → event       │
                    └────────────────┬────────────────┘
                                     │
       ┌──────────────┬──────────────┼──────────────┬──────────────┐
       │              │              │              │              │
┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
│    core     │ │   store    │ │ paperless  │ │    pdf     │ │    sim     │
│ reduce()    │ │ append-only│ │ HTTP +     │ │ bytes →    │ │ virtual    │
│ next()      │ │ log +      │ │ task       │ │ sha256     │ │ clock,     │
│ pure        │ │ projections│ │ reading    │ │ pure       │ │ faults     │
└─────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
```

The core decides; the engine performs; the app runs the engine. That split is what
makes the interesting behaviour testable without a device, a network, or an emulator.

## The document lifecycle

Status is derived from the log, never stored, so illegal transitions cannot be
represented.

```
DRAFT ──Enqueued──▶ QUEUED ──▶ UPLOADING ──TaskAccepted──▶ AWAITING_SERVER
                       ▲            │                              │
                       │            │ retryable failure            │ ServerConfirmed
                       │            ▼                              │
                       └──────── BACKOFF                           ▼
                                    │                           SYNCED
                     budget spent   │        auth/URL/TLS
                                    ▼             ▼
                                 FAILED        BLOCKED
                                    │             │
                                    └─ RetryRequested ─▶ QUEUED
```

Three invariants matter more than the rest:

1. **Nothing leaves `AWAITING_SERVER` by uploading.** Once a task id exists the bytes
   may be on the server; the only legal move is to poll. Asserted exhaustively over
   every possible tick in `machine.test.ts`.
2. **`FAILED` never means "gone."** Automatic retries stopped; the local copy is
   still there, and the reducer refuses to record a local-file release for any
   document that is not `SYNCED`.
3. **The log is append-only in the database**, enforced by triggers rather than by
   convention.
4. **Post-sync work is bounded.** Fetching suggestions and saving details happen to a
   document that is already safe, so they get a backoff, a budget, and a terminal
   "given up" state. Without it, a server that answers 404 gets asked on every tick
   for the life of the app.

## Why an event log

- Crash recovery is structural. Truncation at a record boundary is the only damage a
  crash can do, and replay of any prefix is valid.
- The reliability acceptance test is a replay test — see
  [`crash-recovery.test.ts`](packages/core/test/crash-recovery.test.ts), which
  truncates a ten-document log at _every_ boundary and asserts nothing is lost and
  nothing can be duplicated.
- The user-facing audit trail is free: it is the log, rendered.

## The port contract

`EnginePorts` is the seam between decisions and effects, and it has one rule:

> Ports return a result for failures they expect, and throw only for what nobody
> can handle.

The engine never wraps a port call in `try/catch`. A thrown error therefore abandons
the tick mid-way — which is exactly what a process death looks like, and exactly what
the log is built to survive. Catching it would turn a clean crash into an invented
outcome.

This is also how the simulator kills a process: a port throws, and the log is left
ending at `UploadStarted`.

## Determinism as a testing strategy

`next()` takes `now` and jitter as inputs, and `UploadFailed` records the jitter it
used, so a replayed log reproduces the same schedule. ESLint forbids `Date.now()` and
`Math.random()` inside `packages/core`.

With a virtual clock, simulated hours run in milliseconds, and a failing seed is a
reproducible bug rather than a flaky test. The simulator drives the **real** engine —
only the world is simulated — so the properties it proves are properties of shipping
code.

## What is verified, and what is not

|               |                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core`, `pdf` | Pure. Unit tested, ~100% of statements. `pdf` also cross-checked against `node:crypto`.                                                                                                                                                                |
| `store`       | Real SQL against `node:sqlite`, and both log implementations held to one parametrised suite.                                                                                                                                                           |
| `paperless`   | Every branch, against an injected transport, and the whole upload/consume/reconcile/browse cycle against a real, disposable Paperless-ngx (`pnpm run test:contract`).                                                                                  |
| `engine`      | Unit tested directly, and driven by the simulator across hundreds of fault schedules.                                                                                                                                                                  |
| `apps/mobile` | Typechecked and linted, and now built and booted in the iOS Simulator with no crash -- the native SQLite write and the layout execute. **Never tapped**: no camera, no permission prompt, nothing requiring a finger, which a simulator cannot supply. |

The `pdf` row is worth expanding: assembled documents are parsed _and rendered_ by
Ghostscript from real JPEG fixtures, and the rendered page is checked for the right
geometry and for actually containing the image. Everything else about that package is
my own reading of the PDF spec checking itself.

Both assumptions this section used to call "open" are now settled by
`packages/paperless/test/contract` (below): `original_filename__istartswith`
does filter correctly on a real server
([0004](docs/adr/0004-reconcile-by-filename.md)), and `interpretTask`'s reading
of a real server's task shape was wrong in two places, now fixed
([0002](docs/adr/0002-exactly-once-via-content-addressing.md)).

## Contract tests: checking the belief, not the code

Every other test in `packages/paperless` proves the code does what it was written
to believe about Paperless -- against a transport this repo controls, so a wrong
belief and its test can agree with each other forever. `packages/paperless/test/
contract/live.test.ts` is the one place that checks the belief itself, against a
real, disposable Paperless-ngx that `run.sh` brings up under its own Docker
Compose project (`sheaf-paperless-contract-test`, its own ports and volumes --
safe to run alongside a real deployment on the same machine) and tears down
again whether the tests passed or not. `vitest.contract.config.ts` at the repo
root keeps it out of `pnpm test`: it needs Docker and real wall-clock time for
Paperless to actually consume each document, neither of which the rest of this
repository's tests may depend on.

It exists because ADR 0002 and ADR 0004 each record an assumption that was
checked once, by hand, and was wrong -- and "by hand" does not catch the next
one. Automating it immediately found two more, neither previously recorded
anywhere: a real Paperless-ngx v3 names the stored document in
`related_document_ids` (a list) and never sets the singular `related_document`
field `interpretTask` was reading, so every resolved id came back null on a
document that was in fact safely stored; and `GET /api/documents/?text=`
400s on a colon in the search text, but only once it actually matches a
document -- a server-side bug in the result highlighter, not something either
`text=` or `query=` avoids, documented on `PaperlessClient#listDocuments`
rather than "fixed". The suite's own fixture text avoids colons for that
reason, the same way it does not retry a genuinely-flaky assertion: a known,
reported limitation shouldn't fail an otherwise-passing run.

Different failure mode from the simulator in `packages/sim`: that proves the
_engine_ survives a hostile network talking to a well-understood target; this
proves the _target_ still behaves the way the engine assumes.

## Browsing the archive: a live proxy on the server, a small deliberate cache on the phone

The app can search and edit documents already in Paperless -- `GET /v1/archive`,
served by `services/ingest/src/paperless-browse.ts` -- which sits deliberately
apart from everything above it. Capture is a write the engine must get exactly
right no matter what the network does to it; browsing is a read with nothing to
get wrong that a retry does not already fix. So the server side gets none of the
event log, the state machine, or the simulator: `paperless-browse.ts` is a
stateless pass-through that asks Paperless live and forgets the answer, the same
choice `retention.ts` makes for the opposite reason -- both exist to stop the
_server_ from holding a second, staleable copy of something Paperless already
stores.

The phone is a different question, answered differently: `packages/archive-cache`
keeps a small, explicit, on-device copy of exactly what someone has opened or
starred -- nothing else, and nothing fetched ahead of being asked for. Its
schema lives beside the capture log's in the same SQLite file but is migrated
and owned separately (`schema.ts` in that package), because it has nothing in
common with the log except the file: one is an append-only record of what this
phone did, the other a bounded, evictable cache of what Paperless already holds.
Search offline is plain `LIKE` over that cache, not FTS5 -- `expo-sqlite`'s FTS5
support has a documented history of regressing silently between SDK releases,
including an Android-only failure, and a cache measured in hundreds of rows has
no need of a ranked index to answer well under a frame.

## `apps/admin`: a second client, reading the same server

The first browser client this project has had, and deliberately the smallest
kind of thing it could be: it polls `GET /v1/health` and draws what comes back
-- forwarding, reconciliation, retention -- rather than leaving that JSON to be
read by hand. No write path, on purpose: managing documents is `/v1/archive`,
which the mobile app already does, and a second client reimplementing that
would be duplicated surface for no new capability.

Getting a browser talking to the ingest server at all needed one real change:
`services/ingest/src/server.ts` now answers every response, and every `OPTIONS`
preflight, with `Access-Control-Allow-Origin: *`. Deliberately wide open --
the bearer token is what actually gates access, there are no cookies here for a
stray origin to ride along on, and restricting the origin would protect
nothing while breaking this dashboard. Found by actually running the thing:
typecheck and a production `vite build` both passed with the server still
CORS-blind, and only pointing a real browser at a real (disposable, separately
ported) instance of the server surfaced `Failed to fetch`.

## Multiple profiles: isolation by file, not by column

More than one named Paperless connection on one phone -- home and work, say --
turned out to need no change at all to `packages/core`, `packages/engine`, or
`packages/store`: every one of them was already parameterised over an injected
`SqlDriver` rather than assuming a single database, because that is what let
tests run against `node:sqlite` in the first place. Isolation is one SQLite
file per profile (`apps/mobile/src/adapters/profiles.ts`'s `databaseNameFor`),
not a `profile_id` column threaded through the log -- the simpler of the two
because nothing has to change to guarantee one profile's log can never be read
while another is active; there is no query that could do it by mistake.

The list of profiles and which one is active are not secrets and live in the
keystore anyway, for the same reason `SHEAF_TOKEN` and a document's bytes live
in two different places on the server: a profile's _token_ is the only part of
it worth protecting, but keeping the list next to the tokens is one dependency
instead of two. An install from before profiles existed is migrated forward
once, as a profile named after its own server address, keeping the exact
database filename (`sheaf.db`) that install's captures already live in -- see
`migrateLegacyConnection` -- so this shipping to someone already mid-outbox
never means renaming a file out from under their own captures.

## Background sync: the same engine, woken from nowhere

`apps/mobile/src/runtime/background-sync.ts` defines a task the OS can invoke
without any screen ever having been open -- there is no `AppProvider`, no
`SyncService`, nothing a component set up for it to reuse. So it does not try
to reuse anything: it rebuilds the exact wiring `SyncService` assembles for
the foreground (a store over the active profile's own database, a
`SheafAdapter`, the same policy), runs `tickAll` once, and lets the process
end. One pass, not a loop -- the OS decides how long the call gets to run, not
this code, and `expo-background-task`'s own `minimumInterval` is a floor the
platform is free to miss entirely if battery or usage patterns say so.

`resuming` is `true` on every single call, not just a first one: this process
did not exist a moment ago and will not exist a moment from now, so it has
exactly the same amnesia about an in-flight upload that a killed-and-relaunched
foreground process has -- which is precisely the condition `resuming` exists
to handle (see "The document lifecycle" above). It only changes anything for a
document already `UPLOADING`; everything else is decided exactly as the
foreground would.

## Deliberate non-goals

No full mirror of the archive -- only what was actually opened or starred, ever.
No bulk document management -- Paperless's own web UI already does that well,
and duplicating it is not the differentiator here. No cloud account, no second
way to edit a document beyond what `/v1/archive` already offers. Capture and
reliable delivery are still the product's centre of gravity; browsing and a
dashboard, on- or offline, are what make that delivery worth checking on.
