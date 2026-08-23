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
- Duplicate detection depends on Paperless's wording and response shape, which vary
  by version. Confined to `interpretTask`, pinned by contract tests.
- Exact-hash matching cannot catch the same receipt photographed twice. That needs
  perceptual hashing, which is a separate concern.
