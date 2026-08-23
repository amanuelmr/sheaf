# 5. Ports return results; a throw means the process is going down

- Status: accepted
- Date: 2026-08-23

## Context

The engine performs every effect through injected ports: upload, poll, reconcile,
patch, delete. Those calls fail constantly — that is the whole problem domain — and
how failure is represented decides what the engine can conclude.

The usual approach is to throw on failure and catch centrally. Applied here it is
actively harmful. An upload that throws could mean the request never left the device,
or that it arrived and the reply was lost. A `catch` has to pick one, and picking
wrong either loses a document or duplicates it.

## Decision

Two channels, with different meanings.

**Expected failures are returned** as an `ApiResult` carrying the same
`FailureReason` the event log records. The engine reads it and appends the
corresponding event. There is no translation layer between "the request failed" and
"the document's log says why".

**Unexpected failures throw, and the engine does not catch them.** No port call is
wrapped. A thrown error propagates out of the tick, leaving the log exactly as it was
mid-effect — typically ending at `UploadStarted`.

## Consequences

Good:

- A crash mid-request is represented honestly: the log records that an attempt was
  made and says nothing about its outcome, which is the truth. `resuming` then turns
  that into a reconciliation rather than a blind re-send.
- The engine has no error-handling policy to get wrong, because it has no error
  handling. Every branch it takes is driven by a value.
- The simulator can express a process kill by having a port throw, so the crash path
  under test is the real one rather than a mock of it.
- Every failure the engine can see is one the reducer already understands, so no
  failure mode can arrive without a defined transition.

Costs:

- Port authors carry the judgement call. A port that throws on something ordinary —
  a 500, a timeout — turns a routine retry into an abandoned tick. The interface
  documents this, but the compiler cannot enforce it.
- An unhandled rejection surfaces as a real error in the app, which needs a top-level
  handler that logs and re-ticks rather than a screen full of red.
- It reads as unusual. Reviewers expect `try/catch` around I/O, so the absence of it
  needs the comment that is there.
