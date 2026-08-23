# 4. Reconcile by upload filename, and never trust the filter

- Status: accepted
- Date: 2026-08-23

## Context

[ADR 0002](0002-exactly-once-via-content-addressing.md) requires that on cold start
we can ask the server: _do you already hold the document with this content hash?_
Without it, a document interrupted mid-upload can only be resolved by uploading it
again and reading the duplicate rejection.

Paperless-ngx has no lookup by content hash. It computes one internally to reject
duplicates, but does not expose it.

The alternatives:

- **A custom field** (`sheaf_id`) written at upload and queried back. Requires
  creating the field, and value assignment during `post_document` varies across
  versions.
- **The original filename.** Paperless stores `original_filename` verbatim and
  supports `original_filename__istartswith` on the documents endpoint. No setup, no
  extra permissions.
- **Full-text search** for the hash. Depends on OCR content; unreliable.

There is a trap in all of the query-based options. Django REST Framework _ignores_
query parameters it does not recognise rather than rejecting them. On a server
without that filter, a search does not fail — it succeeds and returns an unfiltered
page of documents.

## Decision

Name every upload `sheaf-<sha256>.pdf` and reconcile with
`original_filename__istartswith`.

Then re-check the result client-side: a candidate only counts as a match if its
`original_filename` actually carries the hash we asked for. Ambiguity of any kind —
no results, missing filenames, an unfiltered page — resolves to "not found".

Separately, `probeReconciliation()` searches for a filename that cannot exist. An
empty result proves the filter narrows; any result proves it was ignored. The probe
is diagnostics, not a gate — correctness does not depend on it.

## Consequences

The asymmetry is the whole point, and it is why this is safe:

- **A false negative is harmless.** We conclude "not on the server", re-upload, and
  the server refuses the bytes as a duplicate — which the engine already reads as
  success. The cost is one redundant upload.
- **A false positive is catastrophic.** We conclude "already there", mark the
  document synced, and a retention policy deletes the only local copy of a document
  that never arrived.

Every step therefore fails towards the negative. A server that ignores the filter
degrades to "reconciliation never finds anything", which costs bandwidth and loses
nothing.

Costs:

- Filenames become load-bearing. If a user or a pre-consume script rewrites
  `original_filename`, reconciliation silently stops working — degrading to
  re-upload, not to data loss.
- `sheaf-<hash>.pdf` is ugly, and it is what users see as the original filename in
  Paperless. A `title` is set separately, so the document itself still reads well.
- Only the first 25 candidates are examined. Since matches are exact after
  re-checking, more than a couple is already pathological.
- Still unvalidated against a real Paperless-ngx across versions. The probe exists
  so that when it does fail, it says so instead of guessing.
