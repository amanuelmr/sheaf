# Sheaf roadmap: from sync engine to standalone product

Written 2026-10-05. Read in order; each is short.

| Doc                                                   | What it answers                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [00 — Assessment](00-assessment.md)                   | What actually works today, measured, and what "not functional" really means                      |
| [01 — Research](01-research.md)                       | Market (Paperless v3 now has AI), OCR, search, AI evals, mobile testing — with sources           |
| [02 — Target architecture](02-target-architecture.md) | Sheaf as system of record; job pipeline, data model, protocol additions, security, observability |
| [03 — Four-week plan](03-four-week-plan.md)           | ~55 hours, week by week, each task with an acceptance check and a cut line                       |
| [04 — Portfolio strategy](04-portfolio-strategy.md)   | How to make the work visible to each kind of reviewer                                            |

**Step-by-step implementation guide:** [implementation/](implementation/README.md) — every step with files, schemas, tests to write first, acceptance checks and known traps.

New decision records (status **proposed** until implemented):

- [0007 — Sheaf is the system of record; Paperless is a connector](../adr/0007-sheaf-is-the-system-of-record.md)
- [0008 — Device pairing](../adr/0008-device-pairing.md)
- [0009 — Edge-first OCR](../adr/0009-edge-first-ocr.md)
- [0010 — Extraction behind a provider port, gated by evals](../adr/0010-extraction-behind-a-provider-port-with-evals.md)

## TL;DR

1. The engine is already strong: 425 passing tests, deterministic fault simulation,
   exactly-once delivery. **Don't rewrite it.**
2. What's missing is a product: it has never run on a phone, and it does nothing
   useful without Paperless-ngx, which now ships its own AI.
3. So: **make it run on real phones (week 1), make the server standalone with
   search (week 2), add measured AI extraction (week 3), then pairing, a web app,
   metrics and the write-up (week 4).**
