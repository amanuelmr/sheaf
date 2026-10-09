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
- 2026-10-05 — OCR sidecar, real container (`ocrmypdf-alpine:v17.13.0`): an
  image-only 300-dpi receipt came back word for word in about 1 s. Three things the
  real run caught that tests had not: the base image already runs as uid 1000, so
  the Dockerfile's `adduser` would have failed the build; the repo's page fixtures
  (480×640) are too small for Tesseract to read at all, so they cannot be used to
  test OCR; and Python's `HTTPServer` spent 35 s on a reverse-DNS lookup at bind.
  Not yet run: the whole stack through compose, since this Mac already serves a
  Sheaf on port 8787.
- 2026-10-06 — Extraction eval, heuristic. First run on the 50-receipt test sample:
  date 98%, total **52%**, sender 96%. The dev set (586 other receipts) disagreed
  about the sender (79.5%), which is why rules are tuned on dev only. The total
  misses were real receipt layout, not edge cases: a GST summary table whose own
  "TOTAL" is the tax, amounts printed two lines below their label, "TOTAL INCL. GST"
  rejected for mentioning GST, and cash tendered taken for the bill. Fixing those
  as general rules: dev 61% → 82%, test 52% → **84%**, other fields unchanged.
- 2026-10-06 — Inbox (3.4) built with Accept and Edit buttons; the swipe gesture is
  left for the device session, since `react-native-gesture-handler` is a native
  module that needs a rebuild to test. Two loose ends: (1) a suggested document date
  is shown but cannot be saved, because protocol v1's `DocumentPatch` has no date;
  (2) the inbox buttons need `testID`s once the step-1.4 branch (which added
  `testID` to `Button`) is merged.
- 2026-10-06 — Found by running the server for the pairing check: since step 3.2,
  `pnpm --filter @sheaf/ingest start` crashed with "Cannot find package
  '@sheaf/extract'". Every test passed, because Vitest resolves packages through
  aliases, and the Docker image worked, because its Dockerfile links packages by hand.
  Only the server's own `package.json` was wrong. CI now starts it outside Docker.
- 2026-10-06 — Chaos run (`pnpm chaos`), 20 phones × 25 documents, three SIGKILLs:
  seeds 1, 2 and 3 each stored exactly 500 documents with 0 lost and 0 duplicated,
  through ~1,400 requests and ~100 replies lost after the server had stored the
  document. Its first full run hung, and the cause was mine: the pairing rate limit
  counted successes, so the eleventh phone paired from one address was refused for a
  minute, and the script retried for ever. The limit now counts only failures.
- 2026-10-06 — Chaos re-run on a seed not used while developing it (seed 7): 500
  documents, 0 lost, 0 duplicated, 3 SIGKILLs, 1,434 requests, 103 replies lost after
  the server had stored the document, 54 s. Four seeds green in total.
- 2026-10-06 — `apps/web` had **no tests at all**, three weeks after it was written,
  because nothing in it had failed and nothing was checking. The first test — routing,
  since a hash is the only user-controlled value that reaches a request path —
  immediately found a money formatter rendering a non-finite amount as "€NaN". The
  lesson is not about `apps/web`: a test count is not coverage, and an app with only
  `tsc --noEmit` can hide a defect indefinitely.
- 2026-10-06 — Paperless-ngx **3.3.0** was published at 03:55Z, hours after the
  stack was pinned to 3.2.1 and verified against it. The pin stays at 3.2.1 on
  purpose: the weekly `latest` leg of the contract workflow is what tests a new
  version before anyone is asked to move. `latest` therefore becomes 3.3.0 on the
  next scheduled run, and a red advisory leg there is the expected signal rather
  than a surprise.
- 2026-10-06 — A review of the merged work found two of our own claims that
  measurement contradicted: the mobile README's bundle size (1,211 modules) was
  stale — a fresh bundle reports 1,251 — and the research note still said the
  contract suite pinned `latest` after the pin had landed. Both are the kind of
  number nobody re-measures once it is written down.
- 2026-10-06 — The end-to-end fixture reaches the scanner by short-circuiting
  `scanDocument()`, where the plan said to go "via the hand-crop fallback path".
  The short circuit is better (no camera UI in a test at all), but it means the
  manual crop screen and the manual fallback branch have **zero** end-to-end
  coverage. Recorded so nobody reads a green flow as "the camera path works".
- 2026-10-06 — The 21 KB end-to-end fixture does ship in a release export, because
  its import is unconditional; only the branch that reads it is unreachable, since
  `EXPO_PUBLIC_*` is inlined at bundle time. The comment claimed the whole thing
  was dead code, which was half true.
- 2026-10-08 — Review of the stacked PRs: the inbox's test ids (loose end 2 above)
  are in, named per document like the outbox rows. A Maestro inbox flow is still
  missing, and not only for want of time: the e2e fixture page is 480×640, too small
  for on-device OCR to read, so a test build never produces suggestions to review.
  It needs a larger fixture first.
- 2026-10-09 — Paperless-ngx **3.3.0** checked against the contract suite locally
  (the GitHub token here cannot dispatch workflows, and the weekly run had not fired
  yet). First run: 10/11, the full-text search missed a document it had just
  consumed. A re-run passed, and so did 3.2.1 as a control, so it was a race, not an
  incompatibility: Paperless updates its search index after consumption, not with it.
  The test now waits for the index (up to 20 s); three further runs on 3.3.0 passed
  11/11. The pin stays at 3.2.1 until someone moves it on purpose.
- 2026-10-09 — The Claude and Ollama extractors have never been scored. The eval
  report has heuristic numbers only, because no API key or Ollama was available and
  there are no recordings. ADR 0010's argument is a comparison, so until a recorded
  run exists that comparison is a design, not a result. Fifty receipts on
  `claude-haiku-4-5` would cost on the order of $0.10.
