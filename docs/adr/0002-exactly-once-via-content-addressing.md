# 2. Achieve exactly-once upload by content-addressing

- Status: accepted
- Date: 2026-08-23

## Context

A mobile uploader on a flaky network hits this constantly: the request is sent, the
server stores the document, and the response is lost. The client cannot tell that
apart from "the server never got it."

Both conventional answers are wrong. Retrying blindly creates duplicates. Not
retrying shows a red failure on a document that is safely stored.

Paperless-ngx makes it subtler still: `POST /api/documents/post_document/` returns a
Celery task id, and a 200 means _accepted for consumption_, not _stored_. The real
outcome only appears later in `/api/tasks/`.

## Decision

1. Identify documents by content: `docId = SHA-256(normalized PDF bytes)`, with
   deterministic PDF assembly so the same pages always hash the same.
2. Persist the task id before concluding anything. A document with a task id enters
   `AWAITING_SERVER`, where the only legal move is to poll — it is never
   re-uploaded.
3. Treat a duplicate rejection as success. Paperless hashes content itself and
   refuses documents it already holds, so being told "duplicate" about bytes we
   chose to upload proves the document is in Paperless.
4. Reconcile against the server on cold start for any document whose fate is
   unknown.

## Consequences

Good:

- Retry is unconditionally safe, with no idempotency key and no server-side
  cooperation. At-least-once delivery yields exactly-once semantics.
- The lost-response case resolves correctly in both directions: stored documents are
  recognised, and genuinely-unsent ones are re-sent.
- Local duplicate detection reuses the same hash for free.

Costs:

- PDF assembly must be byte-deterministic — no embedded timestamps or producer
  strings. A change to the assembler changes every hash.
- Duplicate detection depends on Paperless's wording and response shape. **Tested
  against a real server, and two of the assumptions here were wrong.** Its task
  status is lowercase (`success`, not `SUCCESS`), so every successful upload read as
  a refusal. And it did _not_ reject a re-sent document: the same bytes produced a
  second document, which is the opposite of what this ADR assumed. The forwarder now
  asks whether the target already holds a document rather than relying on it to say
  no. Note that exactly-once between the phone and _our own_ server never depended on
  any of this — that comes from the addressing, and held throughout.
- Exact-hash matching cannot catch the same receipt photographed twice. That needs
  perceptual hashing, which is a separate concern.

## Amendment: the second hop needed more than asking

Asking the target whether it already holds the document was, on its own, not enough
to make the hand-off exactly-once. Two windows survived it:

- Between the target accepting the bytes and finishing consumption, the document does
  not exist yet, so the question honestly answers no. A process that died in there
  came back with nothing written down and sent again.
- A send whose reply was lost is indistinguishable from one that never left, and was
  being recorded as the latter.

Both were found by putting the forwarder under the same deterministic simulator the
phone's hop has always had — and both showed up on a _flaky_ profile, not just a
hostile one, so this was not an exotic schedule. Three changes fixed it:

1. Record that a hand-off is under way **before** making it, mirroring the phone's
   log, where the attempt precedes the request.
2. Keep a failed send in that unresolved state rather than reverting it to pending,
   because "it failed" is not the same claim as "it never left".
3. Resolve an unresolved hand-off by asking the target what it has _in flight_
   (`findTaskByCaptureId`), not just what it has stored. The task row exists from the
   moment the upload is accepted, which is exactly the window that was open.

There is a general shape here, and it is the same mistake twice: **a question that
could not be asked is not a question that was answered no.** The pre-flight check
was also reading an unreachable target as "it does not have this", which turned a
network blip into a duplicate. Both now wait instead of assuming.

The contrast with the first hop is the argument for the protocol. Between the phone
and our own server, none of this exists: the address _is_ the content, so re-sending
is a no-op and there is no window to be caught in. All of the machinery above is the
price of talking to a system that was not designed for it — paid once, on a server,
where a retry costs nothing and nobody is waiting.

Related: the forwarder no longer borrows the phone's attempt budget. That budget
exists because stopping means asking the user; on the server nobody is watching and
the document is already safe, so a retryable failure retries at the capped backoff
for as long as it takes. Only a refusal that retrying cannot change stops the loop.
