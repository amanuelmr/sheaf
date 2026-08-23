# Architecture

## Layers

```
                    ┌─────────────────────────────┐
                    │        apps/mobile          │
                    │  camera · SQLite · UI       │
                    │  (all effects live here)    │
                    └──────────────┬──────────────┘
                                   │  events in, commands out
                    ┌──────────────▼──────────────┐
                    │      packages/core          │
                    │  reduce(events) → state     │
                    │  next(state, tick) → cmd    │
                    │  pure · no clock · no I/O   │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
   ┌──────────▼──────────┐                 ┌────────────▼────────────┐
   │ packages/paperless  │                 │     packages/sim        │
   │ HTTP + task reading │                 │ virtual clock · seeded  │
   └─────────────────────┘                 │ RNG · injected faults   │
                                           └─────────────────────────┘
```

The core decides; the app acts. That split is what makes the interesting behaviour
testable without a device, a network, or an emulator.

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

Two invariants matter more than the rest:

1. **Nothing leaves `AWAITING_SERVER` by uploading.** Once a task id exists, the
   bytes may be on the server; the only legal move is to poll. Asserted
   exhaustively over every possible tick in `machine.test.ts`.
2. **`FAILED` never means "gone."** Automatic retries stopped; the local copy is
   still there, and the reducer refuses to record a local-file release for any
   document that is not `SYNCED`.

## Why an event log

- Crash recovery is structural. Truncation at a record boundary is the only damage
  a crash can do, and replay of any prefix is valid.
- The reliability acceptance test is a replay test — see
  [`crash-recovery.test.ts`](packages/core/test/crash-recovery.test.ts), which
  truncates a ten-document log at _every_ boundary and asserts nothing is lost and
  nothing can be duplicated.
- The user-facing audit trail is free: it is the log, rendered.

## Determinism as a testing strategy

`next()` takes `now` and jitter as inputs, and `UploadFailed` records the jitter it
used, so a replayed log reproduces the same schedule. With a virtual clock, simulated
hours run in milliseconds, and a failing seed is a reproducible bug rather than a
flaky test.

The planned fault injector covers: dropped connections, 5xx, 401, timeouts, lost
responses, duplicate replies, clock jumps, process kills at arbitrary points, and
disk-full. Contract tests against a real Paperless-ngx in Docker validate the
assumptions the simulator encodes.

## Deliberate non-goals

Sheaf does not browse, search, or manage documents, and has no dashboard, no
backend, and no cloud account. Paperless-ngx already does all of that, better. The
entire product surface is capture and reliable delivery.
