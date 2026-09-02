# Contract tests

`live.test.ts` talks to a real Paperless-ngx, not an injected transport. Every
other test in `@sheaf/paperless` proves the code does what it was written to
believe about Paperless; this is the one place that checks the belief itself.
It exists because two of those beliefs -- documented in
[ADR 0002](../../../../docs/adr/0002-exactly-once-via-content-addressing.md)
and [ADR 0004](../../../../docs/adr/0004-reconcile-by-filename.md) -- were
checked once, by hand, and were wrong: task status is lowercase, not
uppercase; a re-sent document is not rejected as a duplicate, it becomes a
second document; and a field returned as `original_file_name` is filtered on
as `original_filename`. Fixture-based tests could not have caught any of that,
because the fixtures were written from the same wrong belief as the code.

Automating the suite (rather than continuing to check these by hand) found two
more: a real Paperless-ngx v3 names the stored document in
`related_document_ids` (a list), never in the `related_document` field ADR
0002 was written against; and `text=` search 400s on a colon in the query, but
only once it actually matches a document — a server-side bug, documented on
`PaperlessClient#listDocuments` rather than "fixed", since there is no
client-side query syntax that avoids it. This suite's own fixture text avoids
colons for that reason, so a real Paperless-ngx bug doesn't fail every run of
an otherwise-passing test.

## Running it

```bash
pnpm run test:contract
```

Brings up a throwaway Paperless-ngx and Redis under a separate Docker Compose
project (`sheaf-paperless-contract-test`), waits for it, resolves an admin
token, runs `live.test.ts` against it, and tears the whole thing down again --
success or failure. Takes a few minutes: real consumption, not a mock
answering instantly. Safe to run alongside an existing `docker compose up`
deployment of Sheaf itself -- different project name, different ports,
different volumes.

Not part of `pnpm test`, and never will be: it needs Docker and real
wall-clock time for Paperless to consume each document, neither of which the
rest of this repository's tests may depend on. `vitest.contract.config.ts` at
the repo root is what keeps `live.test.ts` out of the default suite; run it
directly and it is skipped, not run, when `PAPERLESS_CONTRACT_URL` is unset.

## What it is not

Not a replacement for the fault-injected simulator in `@sheaf/sim` or
`services/ingest/test/forward-sim.ts` -- those prove the _engine_ survives a
hostile network talking to a well-understood target. This proves the
_target_ still behaves the way the engine assumes. Different failure mode,
different test.
