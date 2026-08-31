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

|               |                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `core`, `pdf` | Pure. Unit tested, ~100% of statements. `pdf` also cross-checked against `node:crypto`.                              |
| `store`       | Real SQL against `node:sqlite`, and both log implementations held to one parametrised suite.                         |
| `paperless`   | Every branch, against an injected transport. Not yet against a real Paperless-ngx.                                   |
| `engine`      | Unit tested directly, and driven by the simulator across hundreds of fault schedules.                                |
| `apps/mobile` | Typechecked and linted. **Never run.** No camera, permission flow, native SQLite write, or layout has been executed. |

The `pdf` row is worth expanding: assembled documents are parsed _and rendered_ by
Ghostscript from real JPEG fixtures, and the rendered page is checked for the right
geometry and for actually containing the image. Everything else about that package is
my own reading of the PDF spec checking itself.

The two open assumptions, both recorded in ADRs: that
`original_filename__istartswith` filters on real servers
([0004](docs/adr/0004-reconcile-by-filename.md)), and that Paperless's duplicate
wording matches what `interpretTask` looks for
([0002](docs/adr/0002-exactly-once-via-content-addressing.md)). Contract tests
against Paperless in Docker are the next thing that would settle both.

## Browsing the archive is a proxy, not a second copy

The app can search and edit documents already in Paperless -- `GET /v1/archive`,
served by `services/ingest/src/paperless-browse.ts` -- which sits deliberately
apart from everything above it. Capture is a write the engine must get exactly
right no matter what the network does to it; browsing is a read with nothing to
get wrong that a retry does not already fix. So it gets none of the event log,
the state machine, or the simulator: `paperless-browse.ts` is a stateless
pass-through that asks Paperless live and forgets the answer, the same choice
`retention.ts` makes for the opposite reason -- both exist to stop this server
from holding a second, staleable copy of something Paperless already stores.

## Deliberate non-goals

No local mirror of the archive, no offline browsing, no bulk document management
-- Paperless's own web UI already does that well, and duplicating it is not the
differentiator here. No dashboard, no cloud account. Capture and reliable
delivery are still the product's centre of gravity; browsing is what makes that
delivery worth checking on from the device that did the capturing.
