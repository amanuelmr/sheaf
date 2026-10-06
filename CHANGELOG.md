# Changelog

Notable changes, newest first. Versions are tagged in git; the plan behind them is in
[docs/roadmap](docs/roadmap/README.md).

## 1.0.0

**Sheaf is now a standalone product.** Its own server keeps, searches and reads your
documents; Paperless-ngx became an optional connector you add when you want it.

- `apps/admin` is now `apps/web`, and it is a real client rather than a health page:
  search, a document page with each field's provenance and its paper trail, a triage
  inbox (`j`/`k`/`a`/`e`), phone pairing by QR, and a system page. The admin token
  moved to `sessionStorage`, so closing the tab forgets it.
- Pair a phone by scanning a QR code: each phone gets its own revocable token, and
  uploads record which phone sent them. `SHEAF_TOKEN` stays the admin's and keeps
  working. A removed phone is told so, and asked to pair again.
- `/metrics` in Prometheus text format, from a dependency-free registry, plus JSON
  logs and an optional `compose.observability.yml` with Prometheus, Grafana and a
  provisioned dashboard. Route labels are templates, never raw paths.
- `pnpm chaos`: 20 virtual phones on a hostile network, the server `SIGKILL`ed three
  times mid-upload, every count checked afterwards. Green on three seeds.
- The contract tests are pinned to Paperless-ngx 3.2.1, which they pass against, and
  a weekly workflow also runs `latest` as an early warning.
- [`docs/FOR-REVIEWERS.md`](docs/FOR-REVIEWERS.md) and a blog post on exactly-once
  capture; a retrospective on what the four-week plan got wrong.
- The phone has an inbox for suggested details: accept, or edit.
- The server reads each document's title, date, sender, type, total and tags, and
  offers them as the suggestions the phone already shows. `SHEAF_EXTRACTOR` picks
  `heuristic` (default, nothing leaves the server), `claude`, `ollama`, or
  `paperless`. A person's edits are never overwritten.
- The phone keeps asking for suggestions for 13–26 minutes instead of about one.
- Optional server-side OCR (`compose.ocr.yml`): an OCRmyPDF sidecar reads
  documents that arrive with no text, after giving the phone two minutes to send its
  own.
- The phone's library browses the server's own documents by default, so it works
  with no Paperless. `SHEAF_ARCHIVE_SOURCE=paperless` browses Paperless instead.
  Native archive documents have no thumbnails yet.
- Full-text search of the server's own documents (`GET /v1/search`): title, details
  and recognised text, ranked, with marked snippets. p95 16.7 ms over 10,000
  documents. Existing documents are indexed when the server starts.
- The phone sends the text it recognised on-device to the server once the document
  is stored there (`PUT /v1/documents/{sha256}/text`), and keeps its local copy until
  that text has been sent. Older logs replay unchanged.
- **Upgrading with Paperless:** `docker compose up` now starts the Sheaf server
  alone. Run `docker compose -f compose.yml -f compose.paperless.yml up -d` to keep
  Paperless; its containers and volumes keep their names, so no data moves.
- **Breaking:** `SHEAF_RETENTION_DAYS` now also needs `SHEAF_RETENTION_CONNECTOR`
  (e.g. `paperless`), naming the connector trusted with the only copy. Without it
  the server refuses to start instead of guessing.
- Forwarding is recorded per connector. Existing forwarding history is carried over.
- The server has ordered, run-once migrations and a job runner for post-upload work,
  proven to converge under crashes across 200 simulated seeds.
- The roadmap: an assessment, research, a target architecture and a four-week plan,
  with ADRs 0007–0010 proposed.
- `pnpm verify` is green again: Expo's generated `expo-env.d.ts` is no longer
  format-checked.
