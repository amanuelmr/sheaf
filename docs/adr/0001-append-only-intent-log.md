# 1. Derive document state from an append-only log

- Status: accepted
- Date: 2026-08-23

## Context

The product promise is "never lose a document." The acceptance test is: ten
documents captured, two uploaded, one mid-upload, app killed — on reopen nothing is
lost and nothing is duplicated.

The conventional design is a mutable `documents` table with a `status` column,
written by both the UI and the sync worker. That shape makes the promise hard to
keep: a crash can land between a file write and a status update, two writers race on
one row, and every new status multiplies the transitions someone has to remember to
forbid.

## Decision

One append-only table of events per document. Nothing is ever updated or deleted.
All state, including status, is derived by replaying the log through a pure reducer.

## Consequences

Good:

- Crash recovery is structural. Truncation at a record boundary is the only damage a
  crash can do, and replaying any prefix is valid — so the acceptance test is a
  replay test over every truncation point, not a hand-written recovery path.
- Illegal transitions are unrepresentable, because status is not a stored field.
- The user-facing audit trail is free: it is the log, rendered.
- The reducer is pure, so the interesting behaviour is testable with no device, no
  network, and no mocks.

Costs:

- Reading current state means a replay. Mitigated by keeping logs per-document and
  short; if profiling ever demands it, a snapshot row is a cache, not a new source
  of truth.
- Every state change needs an event type, which is more ceremony than an `UPDATE`.
- Log growth is unbounded without a compaction story for long-synced documents.
