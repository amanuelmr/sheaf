# 00 — Where Sheaf actually stands (2026-10-05)

Written before any of the plan, because a plan built on "it's horrible and doesn't
work" would throw away the most valuable thing this repository has.

## The honest verdict

**The engine is portfolio-grade already. The product is not.** Those are different
problems with different fixes, and almost all of the month should go to the second.

Measured today, on `main` at `b8e5f06`:

| Check                          | Result                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `pnpm test`                    | **425 tests, 36 files, all passing**, 1.5 s                  |
| `pnpm run typecheck`           | Clean across packages, mobile and admin                      |
| iOS Simulator build            | `** BUILD SUCCEEDED **` (`apps/mobile/.expo/xcodebuild.log`) |
| Contract tests vs Paperless    | Exist and automated (`pnpm run test:contract`)               |
| Deterministic fault simulation | 300 schedules, 1,500 docs, 3,644 process kills, 0 lost/duped |
| Source size                    | ~18k lines of TypeScript, 12 packages/apps/services          |
| Real phone, real finger        | **Never.** Not once.                                         |
| Android                        | **Never built.**                                             |
| Usable without Paperless-ngx   | **No.** Search, OCR, metadata, browsing all borrow Paperless |

## What is genuinely strong (keep, and show off)

1. **Event-sourced, crash-proof outbox** (`packages/core`, `packages/store`, ADR 0001).
   Status is derived, never stored; the log is append-only by trigger; recovery is a
   property of the data structure. This is the kind of thing interviewers ask about.
2. **Exactly-once via content addressing** (`PUT /v1/documents/{sha256}`, ADR 0002,
   `packages/protocol`). Idempotency as a consequence of the URL, not a feature.
3. **Deterministic simulation testing** (`packages/sim`). Pure core, injected clock and
   jitter, ESLint banning `Date.now()`/`Math.random()` in `core`. This is the
   FoundationDB / TigerBeetle school of testing, and very few portfolio projects have
   it.
4. **Testing beliefs, not just code** — the contract suite against a disposable real
   Paperless found real-world bugs unit tests could not.
5. **Hexagonal seams already exist.** `ForwardTarget` (`services/ingest/src/forwarder.ts`),
   the archive source, suggestion source and vocabulary are already ports with a
   Paperless adapter behind each. Going standalone is _adding adapters_, not a rewrite.
6. **Writing.** Six ADRs that record measured decisions, including reversals. Rare,
   and exactly what senior reviewers look for.

## What is weak (this is what "not functional" really means)

| Problem                                                     | Why it matters                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Never run on a device                                       | Nobody can say "it works". A reviewer who clones it hits setup walls immediately.                  |
| Hard dependency on Paperless-ngx for anything useful        | Without it you get a box of unsearchable PDFs (compose.yml says so itself). Not a product alone.   |
| Paperless v3 (Jul 2026) shipped its own AI suggestions      | Sheaf's "classify later from Paperless suggestions" story is now Paperless's feature, not Sheaf's. |
| One shared `SHEAF_TOKEN` typed by hand                      | Painful onboarding, no per-device revocation, no audit of who uploaded what.                       |
| README status table is stale ("app not started")            | The first thing a recruiter reads undersells the project by a year of work.                        |
| No screenshots, no video, no live demo                      | Portfolio reviewers spend ~2 minutes. Nothing here can be _seen_ in 2 minutes.                     |
| Admin is a read-only health page                            | No web way to search or read documents, so the server has no face.                                 |
| No metrics/tracing                                          | The "distributed systems" story has no operational half.                                           |
| Committed noise: `coverage/`, `.sheaf-data/`, `.expo/` logs | Ignored by git, so fine in the repo — but make sure they never get published in screenshots/zips.  |

## The reframe

Sheaf today is _a very good sync engine looking for a product_. The plan in
[03-four-week-plan.md](03-four-week-plan.md) gives it one: Sheaf becomes the system
of record for your documents — capture, OCR, search, AI extraction — with Paperless
and others demoted to optional connectors. Every existing guarantee carries over
unchanged, because they all sit beneath the seam that moves.
