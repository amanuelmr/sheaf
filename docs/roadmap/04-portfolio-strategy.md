# 04 — Portfolio strategy: making the work visible

The engineering here is already deeper than most portfolio projects. The problem is
that none of it can be _seen_ quickly. This is the plan for that.

## The two-minute reviewer, then the two-hour reviewer

**Two minutes** (recruiter, hiring manager): the README fold must answer _what is it_,
_does it work_, _why is it hard_ — with a GIF, three screenshots, and three numbers:

> 0 documents lost or duplicated across 3,644 simulated process kills ·
> 425+ tests · fields extracted at **N%** accuracy on SROIE, $0.000X per document

**Two hours** (senior engineer in a take-home review or onsite): ADRs, the simulator,
the contract tests, the eval harness, the job-runner convergence tests. These already
exist or are planned; the job is to link them from the README in the right order.

## One story per role

You asked for all four. Same project, different first paragraph:

| Role                      | Lead with                                                                                      | Point at                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mobile engineer           | Offline-first capture that survives being killed mid-upload; on-device OCR; native scanner     | `apps/mobile`, Maestro flows, demo video, `background-sync.ts`   |
| Backend / distributed sys | Exactly-once delivery over an unreliable link via content addressing; deterministic simulation | ADR 0001/0002, `packages/sim`, job runner, chaos script, metrics |
| AI / ML                   | Extraction behind a provider port, with a real eval harness and regression gate in CI          | `packages/extract/eval/report.md`, ADR 0010                      |
| Full-stack                | Phone + server + web + infra in one coherent system, one `docker compose up`                   | Architecture diagram, `apps/web`, compose files                  |

Put this table in a short `docs/FOR-REVIEWERS.md` and link it from the README.

## Show-off pieces worth their hours

Ordered by impressiveness per hour:

1. **The paper trail, rendered.** The event log as a timeline in the web app and on the
   phone ("captured offline → 3 failed attempts → network back → accepted →
   extracted → you corrected the date"). It is unique, visual, and it is just a query.
2. **The chaos demo.** `scripts/demo-load.ts` killing the server mid-load and printing
   `lost: 0 · duplicated: 0`. Record it as a terminal GIF (asciinema/vhs).
3. **The eval report.** A table with accuracy per field, per provider, with cost and
   latency, and a CI gate. Almost no hobby AI project has one.
4. **A Grafana screenshot** during the load test: request rate, job queue draining,
   connector lag.
5. **The "seven defects tests found" section** — already in the README; keep it, and
   add new entries as week 1–4 finds more. Honest failure stories are what interviewers
   remember.
6. **Flight-mode demo video**: scan 10 pages in flight mode, turn the radio on, watch
   them land.

## The write-up (blog post outline)

Title: _"Exactly-once document capture on a phone, with no idempotency key"_

1. The bug nobody handles: the response lost after the server stored it.
2. Content addressing: identity as a hash, retry as a no-op.
3. Derived status from an append-only log; crash recovery as a data-structure property.
4. Deterministic simulation: what 3,644 process kills found (with the SHA-256 padding
   bug as the hook).
5. Testing the belief: contract tests against a real Paperless found what mocks never could.
6. Going standalone: the same idempotency, one level up, for OCR and AI jobs.
7. Measuring the AI: evals, and why the default extractor is a regex.

Cross-post to dev.to / Hashnode / your own site; share on LinkedIn, r/selfhosted
(Sheaf genuinely helps that audience), and Hacker News "Show HN" once v1.0 has a
working demo.

## Repository hygiene checklist

- [ ] README fold: tagline, GIF, 3 numbers, quick start that works first time
- [ ] GitHub About: description, topics (`offline-first`, `react-native`, `expo`,
      `event-sourcing`, `paperless-ngx`, `ocr`, `llm`, `self-hosted`), website link
- [ ] Badges: CI, coverage, licence
- [ ] `CHANGELOG.md` and tagged releases v0.2 → v1.0
- [ ] Pinned on your GitHub profile; first line of your CV project section
- [ ] `docs/FOR-REVIEWERS.md`
- [ ] Remove anything personal from screenshots and fixtures; demo data is synthetic

## Interview prep: questions this project should let you answer

- Why not CRDTs / ElectricSQL / PowerSync? (Single-writer log; research §6.)
- What happens if the phone dies between "upload started" and "upload finished"?
- How do you know the AI got better, not just different?
- How would you scale this past one home server? (Blob store to S3, jobs to a
  queue, SQLite to Postgres; the ports are already the seams.)
- What did a test find that you were sure was right?
