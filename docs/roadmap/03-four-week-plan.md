# 03 — The four-week plan (part-time, ~12–15 h/week)

**Budget: ~50–60 hours.** That is not much, so the plan is ordered by
_value-if-we-stop-here_: at the end of every week the project is more impressive
than at the start, and nothing half-finished is left in `main`.

Each item has an **acceptance check**: if it is not demonstrably true, the item is
not done. Items marked ✂️ are the first to cut if a week runs long.

---

## Week 1 — Make it real (it works on a phone, and you can show it)

> Goal: someone else can watch a paper go from camera to searchable in under a minute.

| #      | Task                                                                                                                                            | Acceptance check                                                                                             | ~h  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --- |
| 1.1    | **Run on a real iPhone** (`expo run:ios --device`). Fix whatever breaks: camera, permissions, scanner, OCR, local-network prompt.               | 10-page batch scanned in flight mode, then the phone goes online and all 10 reach the server. No duplicates. | 4   |
| 1.2    | **Android build** via `expo run:android` or EAS.                                                                                                | Same check on an Android device or emulator.                                                                 | 2   |
| 1.3    | **Re-run the contract suite against Paperless v3.x**; fix `tasks.ts` if the new tasks API changed shape.                                        | `pnpm run test:contract` green on the current `latest` tag; tag pinned in its compose file.                  | 2   |
| 1.4    | **Maestro smoke flow** (`apps/mobile/e2e/smoke.yaml`): connect → capture (fixture image via the hand-crop fallback path) → outbox shows synced. | Runs locally on the simulator; documented in `apps/mobile/README.md`.                                        | 2   |
| 1.5    | **Fix the README's front page.** Replace the stale Status table, add a 30-second GIF and 3 screenshots, link `docs/roadmap/`.                   | A stranger can tell what it is, and see it working, without scrolling past the fold.                         | 1.5 |
| 1.6 ✂️ | Record a 90-second demo video (flight-mode capture → reconnect → paper trail).                                                                  | Uploaded, linked from README.                                                                                | 1   |

**Checkpoint:** tag `v0.2.0` — "it runs on real phones".

---

## Week 2 — Standalone (useful without Paperless)

> Goal: `docker compose up` with no Paperless gives you capture + search. Per
> [ADR 0007](../adr/0007-sheaf-is-the-system-of-record.md), [0009](../adr/0009-edge-first-ocr.md).

| #      | Task                                                                                                                                                                              | Acceptance check                                                                                                             | ~h  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| 2.1    | **Durable job table + runner** in `services/ingest/src/jobs.ts`, generalising the forwarder's state columns. Steps keyed by `(sha256, step, version)`.                            | Unit tests: re-run is a no-op; version bump backfills; kill between steps converges (extend `forward-sim.ts`).               | 4   |
| 2.2    | **`Connector` port.** Move `paperless-target.ts` behind it; migrate `forward_*` columns into `deliveries`. Paperless becomes opt-in via `compose.paperless.yml`.                  | Existing forwarder tests pass unchanged against the new seam; old DB migrates forward (test with a fixture DB).              | 3   |
| 2.3    | **Edge text upload.** `PUT /v1/documents/{sha}/text` in `packages/protocol` + router; mobile engine sends `outbox-ocr` text after the PDF. New engine port, so `core` stays pure. | Protocol test; engine test that text upload is bounded post-sync work; sim still converges.                                  | 3   |
| 2.4    | **FTS5 index + `GET /v1/search`.** External-content FTS5 over title/fields/text, BM25, snippet().                                                                                 | Search for a word printed on a scanned receipt returns it ranked first; 10k-doc fixture queries < 20 ms (benchmark in test). | 3   |
| 2.5    | **Native `ArchiveSource`** over the catalog, default when Paperless is off. Mobile library works against it unmodified.                                                           | Library screen on the phone browses and searches with Paperless stopped.                                                     | 2   |
| 2.6 ✂️ | **OCRmyPDF sidecar** (`services/ocr`, tiny HTTP wrapper) for docs that arrive without text.                                                                                       | A PDF uploaded with no text becomes searchable within a minute.                                                              | 2   |

**Checkpoint:** tag `v0.3.0` — "standalone". README architecture diagram updated.

---

## Week 3 — Intelligence, with evidence

> Goal: documents arrive with fields filled in, and you can prove how good that is.
> Per [ADR 0010](../adr/0010-extraction-behind-a-provider-port-with-evals.md).

| #      | Task                                                                                                                                                                                                                                      | Acceptance check                                                                            | ~h  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --- |
| 3.1    | **`Extractor` port + schema** (`packages/extract`): title, date, correspondent, type, total, currency, tags, per-field confidence. Pure normalisers (dates, money) fully unit-tested.                                                     | 100% statement coverage on normalisers, like `core`.                                        | 3   |
| 3.2    | **Adapters:** `heuristic` (regex, no network, the default), `claude` (structured output via tool use, `claude-haiku-4-5`), `ollama`.                                                                                                      | Each passes the same parametrised adapter suite against recorded responses.                 | 3   |
| 3.3    | **Eval harness** (`packages/extract/eval`): ~50 SROIE test receipts + ~30 of your own labelled scans. Per-field exact/normalised match, cost/doc, p50/p95 latency. `pnpm eval` writes `eval/report.md`. CI runs it on recorded responses. | Report table checked in; CI fails if accuracy regresses > 2 pts vs the checked-in baseline. | 4   |
| 3.4    | **Inbox triage on the phone** — the swipe-to-accept screen the README has promised since day one, backed by `GET /v1/inbox` and `fields` provenance. User edits are `source: user` and never overwritten.                                 | Maestro flow: open inbox → accept one → edit one → both persist across restart.             | 3   |
| 3.5 ✂️ | **Extraction cost & latency in `/metrics`.**                                                                                                                                                                                              | Visible in the week-4 dashboard.                                                            | 1   |

**Checkpoint:** tag `v0.4.0` — "it reads your documents". Eval report linked from README.

---

## Week 4 — A face, a pulse, and the story

> Goal: a reviewer with two minutes is impressed; a reviewer with two hours is more so.

| #   | Task                                                                                                                                                                                      | Acceptance check                                                                                                                                                | ~h  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 4.1 | **Device pairing** ([ADR 0008](../adr/0008-device-pairing.md)): `POST /v1/pair`, `devices` table, QR in web app, scanner on the phone's connect screen. `SHEAF_TOKEN` becomes admin-only. | Pair a phone by scanning a QR; revoke it from the web; its next request gets 401 and the app shows "this device was removed". Tokens stored only hashed (test). | 4   |
| 4.2 | **`apps/web`**: search, document view with paper trail, inbox, devices. Grows out of `apps/admin`.                                                                                        | All four pages work against a seeded demo server; Vite build in CI.                                                                                             | 4   |
| 4.3 | **Observability:** JSON logs with request ids, `/metrics`, `compose.observability.yml` with one Grafana dashboard JSON.                                                                   | Screenshot of the dashboard during a 500-document load script.                                                                                                  | 2   |
| 4.4 | **Load + chaos script** (`scripts/demo-load.ts`): N fake devices upload through flaky links; kill the server mid-run; restart; assert 0 lost / 0 duplicated.                              | Prints a summary table; numbers go in the README.                                                                                                               | 1.5 |
| 4.5 | **The write-up** (`docs/roadmap/04-portfolio-strategy.md` has the outline): blog post + README rewrite + architecture diagrams.                                                           | Published; linked from the repo About.                                                                                                                          | 2   |

**Checkpoint:** tag `v1.0.0`.

---

## The cut line

If only two weeks are available: do **Week 1** and **2.1–2.5**. That already turns
"a sync engine for someone else's server" into "a standalone product that runs on
real phones", which is the single biggest jump in how the project reads.

If a week overruns, cut ✂️ items first, then move the remaining work to the next
week rather than starting new work in parallel. Half-finished features are worse for
a portfolio than missing ones.

## After the month (stretch roadmap)

1. **Semantic + hybrid search**: sqlite-vec embeddings, RRF fusion, evaluated with a
   small labelled query set (MRR@10) — same "measure it" discipline as extraction.
2. **On-device extraction** with Apple Foundation Models (`@Generable`), so fields
   exist before upload and nothing leaves the phone. Compare with server results in
   the same eval harness.
3. **Ask your documents** (RAG over your own archive, citations to page and sha).
4. **TestFlight + Play internal testing**; a public demo server with seeded,
   synthetic documents that resets nightly.
5. **Multi-user households**: users own devices; per-user visibility.
6. **End-to-end encrypted blobs** for the folder/S3 connectors (age/XChaCha20), so
   off-site backup never holds plaintext.
7. **Email and share-sheet ingest** (forward a PDF, share from Files) through the same
   `PUT`, so capture is not camera-only.

## Working agreement

- One PR per numbered task, each with tests, behind green `pnpm verify`.
- Any decision that reverses or extends an ADR gets an ADR (or an amendment) in the
  same PR — keep the repository's best habit.
- Every week ends with a tag, a CHANGELOG entry and a screenshot/GIF.

---

## What the plan got wrong

Written after the fact, from
[`implementation/field-notes.md`](implementation/field-notes.md). A plan that admits
its misses is worth more than one that claims it was right.

**Week 1 needed a phone, and that is the one thing the plan could not supply.** 1.1,
1.2, 1.4 and 1.6 — the real iPhone, the Android build, the Maestro flow, the demo
video — are all still unrun. That is roughly a fifth of the month's work, and it is
the part that would most have improved the project. Everything since has been built
without ever touching the camera, the permission prompts or a finger. **A plan whose
first week depends on hardware should say so in week 0, and have a fallback week
that does not.**

**The plan wrote its own bug.** 2.5 specified using `documents.rowid` as the native
archive id. `documents` has a text primary key, so SQLite may renumber rowids under
`VACUUM` — and the phone caches those ids. It was in the guide as a settled
instruction, so it would have been implemented. Step-by-step guides written before
the code read like fact; the one that deserved checking got checked, and the rest did
not.

**Time estimates for anything involving a container were fantasy.** The Paperless-ngx
image is 3.4 GB and took about 45 minutes to download on this connection. Step 1.3 was
budgeted at 2 hours and was mostly waiting.

**Weeks 3 and 4 were much larger than weeks 1 and 2.** Week 4 was "a face, a pulse,
the story" — device pairing, a five-page web app, metrics, a Grafana dashboard, a chaos
harness and a write-up, budgeted at roughly 10 hours. It was several times that. Tasks
were sized by how interesting they were rather than by how many unknowns they
contained.

**The eval work was underestimated in the best way.** Step 3.3 was budgeted at 4 hours
and was the highest-leverage thing in the month, because it turned "the AI is nice"
into a number with a CI gate. Tuning the default extractor from 52% to 84% on held-out
receipts took longer than planned and was the most valuable hour spent.

**Two things the plan never mentioned, both of which belonged in week 1:**

- **Starting the server the way a developer does.** An undeclared package dependency
  made `pnpm --filter @sheaf/ingest start` crash while every test passed — Vitest
  resolves workspace packages through aliases, and the Docker image links them by hand.
  The production path was broken in a way the test environment was structurally unable
  to see. CI now starts the server outside Docker.
- **Rate limits on a shared address.** The pairing limiter counted successes, so the
  eleventh phone on one household's NAT was refused for a minute. Only the chaos run —
  20 phones from one address — found it.

**Also underestimated: the cost of the write-up.** The README's defects section is the
most-read part of this repository, and its best material came from the field notes,
which only exist because step 0 asked for them.
