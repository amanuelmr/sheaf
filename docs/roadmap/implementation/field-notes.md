# Field notes

A dated line for every surprise found while building the roadmap, especially on real
devices. This is the raw material for the write-up in step 4.5.

## Environment

| Tool    | Version                                |
| ------- | -------------------------------------- |
| Xcode   | 26.2                                   |
| Node    | 24.21.0                                |
| pnpm    | 10.30.2                                |
| Docker  | 28.5.2                                 |
| iPhone  | _model / iOS version — fill in at 1.1_ |
| Android | _not installed yet (no SDK, no adb)_   |
| Maestro | _not installed yet_                    |

## Notes

- 2026-10-05 — `pnpm verify` failed on a clean checkout because Prettier checked
  Expo's generated `apps/mobile/expo-env.d.ts`. Ignored it; CI is a real signal again.
- 2026-10-05 — Contract suite against a real Paperless-ngx **3.2.1**: 11/11 pass.
  The v3 tasks redesign and the API-version cut did not touch anything Sheaf reads,
  so no client change was needed. Pinned the contract stack to 3.2.1; a weekly
  workflow also runs `latest` as an early warning. The image download took ~45
  minutes on this connection, which is worth knowing before a demo.
- 2026-10-05 — Search benchmark (`pnpm bench:search`), 10,000 documents × 300 words
  on this Mac: indexing 10.6 s, query p50 9.8 ms, p95 16.7 ms. Raw user input breaks
  FTS5 five different ways (`total:`, an unmatched quote, `(((`, `*^`, a leading `-`),
  so input is turned into quoted prefix terms and never parsed.
- 2026-10-05 — The guide said to use `documents.rowid` as the native archive id. That
  would have been a bug: `documents` has a text primary key, so SQLite may renumber
  its rowids on `VACUUM`, and the phone caches archive ids. Ids now live in an
  `archive_ids` table whose `INTEGER PRIMARY KEY` never moves; a test vacuums and
  checks.
