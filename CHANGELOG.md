# Changelog

Notable changes, newest first. Versions are tagged in git; the plan behind them is in
[docs/roadmap](docs/roadmap/README.md).

## Unreleased

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
