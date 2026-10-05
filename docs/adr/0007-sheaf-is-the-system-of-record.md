# 7. Sheaf is the system of record; Paperless is a connector

- Status: accepted
- Date: 2026-10-05 (accepted on implementation in steps 2.1–2.6, with native suggestions from ADR 0010 in 3.2)

## Context

Sheaf's server stores every document by content hash and forwards it to Paperless-ngx,
which supplies everything that makes a stored document useful: OCR, search,
metadata suggestions, browsing. Without Paperless, `compose.yml` itself says the
server "holds PDFs you cannot search, which is worse than leaving them in your camera
roll."

Two things changed. Paperless-ngx 3.0 (2026-07-22) shipped its own AI suggestions,
so ADR 0003's "classify later, from Paperless's suggestions" is now Paperless's
feature rather than Sheaf's. And the phone already OCRs every page on-device
(`packages/outbox-ocr`), so the most expensive thing Paperless does for us is often
already done before upload.

The seams needed to change this already exist: `ForwardTarget`, the archive source,
the suggestion source and the vocabulary are each a port with one Paperless adapter.

## Decision

The Sheaf server becomes the system of record: it holds the catalog, the text, the
extracted fields and the search index for every document it receives. Downstream
systems — Paperless-ngx first, then a folder or S3 — are **connectors**: optional,
independent, fan-out deliveries, each with its own state per document.

- `ForwardTarget` is renamed `Connector`; the `forward_*` columns move to a
  `deliveries (sha256, connector)` table, migrated forward.
- A native `ArchiveSource` and `SuggestionSource` over the catalog are the defaults.
  The Paperless ones stay available when that connector is configured.
- `compose.yml` runs Sheaf standalone; `compose.paperless.yml` adds Paperless.
- The phone-facing protocol changes **additively only**.

## Consequences

Good: Sheaf is useful on its own; Paperless users lose nothing; more than one
destination becomes possible; the capture guarantees are untouched because they sit
below the seam.

Bad: Sheaf now owns search and metadata quality, which Paperless did for free — hence
ADRs 0009 and 0010. ADR 0004 (reconcile by filename) becomes specific to the
Paperless connector rather than a property of the system.
