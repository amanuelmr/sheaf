# For reviewers

A map from "what would you like to see" to the exact file that shows it. Everything
here is on `main` and runnable; nothing is a screenshot of a claim.

Start with the [README](../README.md) (two minutes), then pick a row.

| Role                              | Lead with                                                                                                                        | Go to                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile engineer**               | Capture that survives the app being killed mid-upload. On-device OCR, a platform scanner, a durable local store.                 | [`packages/core`](../packages/core) (the state machine), [`packages/store`](../packages/store) (SQLite log + projections), [`packages/engine`](../packages/engine) (effects), [`packages/outbox-ocr`](../packages/outbox-ocr), [`apps/mobile`](../apps/mobile)                            |
| **Backend / distributed systems** | Exactly-once delivery over an unreliable link by content addressing; durable jobs that resume after `SIGKILL`; chaos under load. | [ADR 0002](../docs/adr/0002-exactly-once-via-content-addressing.md), [`services/ingest/src/jobs.ts`](../services/ingest/src/jobs.ts), [`packages/sim`](../packages/sim), [`scripts/chaos.ts`](../scripts/chaos.ts), [`services/ingest/src/metrics.ts`](../services/ingest/src/metrics.ts) |
| **AI / ML**                       | Extraction behind a provider port, with a real eval harness, a held-out set and a CI regression gate.                            | [ADR 0010](../docs/adr/0010-extraction-behind-a-provider-port-with-evals.md), [`packages/extract`](../packages/extract), [eval report](../packages/extract/eval/report.md)                                                                                                                |
| **Full-stack**                    | Phone, server, web app and infra as one coherent system; one `docker compose up`.                                                | [ARCHITECTURE.md](../ARCHITECTURE.md), [`apps/web`](../apps/web), [`compose.yml`](../compose.yml), [`compose.paperless.yml`](../compose.paperless.yml), [`compose.ocr.yml`](../compose.ocr.yml), [`compose.observability.yml`](../compose.observability.yml)                              |

## If you only read three files

1. [ADR 0002 — exactly-once via content addressing](../docs/adr/0002-exactly-once-via-content-addressing.md).
   The core idea, and the failure it exists to handle.
2. [`packages/sim`](../packages/sim/README.md). 3,644 process kills, and the
   reason a phone app can promise not to lose a scan.
3. [The "defects tests found" section of the README](../README.md#verification).
   Honest failure stories are the most reliable signal in a portfolio.

## The numbers, and how to re-check them

| Claim                                                                        | Where it comes from                                                                                                      | Re-run with                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 735 tests, coverage floors on `core`, `engine`, `pdf`, extract's normalisers | [`vitest.config.ts`](../vitest.config.ts)                                                                                | `pnpm verify`                  |
| 0 lost, 0 duplicated across 3,644 process kills                              | [`packages/sim/test`](../packages/sim/test)                                                                              | `pnpm test` (part of `verify`) |
| 500 documents, 0 lost/duplicated through 3 SIGKILLs, ×4 seeds                | [`scripts/chaos.ts`](../scripts/chaos.ts)                                                                                | `pnpm chaos --seed 1`          |
| Search p95 16.7 ms at 10,000 documents                                       | [`services/ingest/test/search-bench.test.ts`](../services/ingest/test/search-bench.test.ts)                              | `pnpm bench:search`            |
| Extraction: date 98%, total 84%, correspondent 96% on held-out SROIE         | [`packages/extract/eval/report.md`](../packages/extract/eval/report.md)                                                  | `pnpm eval`                    |
| Extraction accuracy is gated in CI                                           | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)                                                                | push a change that breaks it   |
| Contract tests pass against real Paperless-ngx 3.2.1, weekly                 | [`packages/paperless/test/contract`](../packages/paperless/test/contract), [workflow](../.github/workflows/contract.yml) | `pnpm run test:contract`       |

## Things that are honestly not done

Stated here so you do not have to find them:

- **The app has never run on a physical device.** It builds, boots in the iOS
  Simulator and passes typecheck/lint/bundle; the camera, permission prompts and
  the Maestro flows have not been exercised on hardware. Android has never been
  built (no SDK on the dev machine).
- **Paperless-ngx v3 compatibility** is a _contract_ result, not a guarantee — it
  is re-checked weekly, and a failure on `latest` is the signal to act.
- **The swipe gesture** on the phone's inbox is unimplemented; it needs
  `react-native-gesture-handler` and therefore a device build to test. Buttons work.
- **A suggested document date cannot be saved from the inbox** — protocol v1's
  `DocumentPatch` has no date field yet. Noted in the field notes.
- **Vectors/semantic search** are not implemented. Search is BM25 (FTS5); the plan
  for the hybrid path is in the research doc.

## The decisions

Ten ADRs, in [`docs/adr`](adr). They are short and each says what was rejected:

| ADR                                                              | Decision                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| [0001](adr/0001-append-only-intent-log.md)                       | Append-only intent log; status is derived                |
| [0002](adr/0002-exactly-once-via-content-addressing.md)          | Content addressing turns at-least-once into exactly-once |
| [0003](adr/0003-upload-first-classify-later.md)                  | Upload first, classify later                             |
| [0004](adr/0004-reconcile-by-filename.md)                        | Reconcile by filename, not metadata                      |
| [0005](adr/0005-ports-return-results-and-throw-for-crashes.md)   | Ports return results; only crashes throw                 |
| [0006](adr/0006-keep-the-ingest-server-as-one-deployment.md)     | One server, one deployment                               |
| [0007](adr/0007-sheaf-is-the-system-of-record.md)                | Sheaf is the system of record; Paperless is a connector  |
| [0008](adr/0008-device-pairing.md)                               | Pair devices with a one-time code, not a shared token    |
| [0009](adr/0009-edge-first-ocr.md)                               | Edge-first OCR, with a server fallback                   |
| [0010](adr/0010-extraction-behind-a-provider-port-with-evals.md) | Extraction behind a provider port, gated by evals        |

The [roadmap](roadmap/README.md) — the assessment, the research with sources, the
target architecture, the week-by-week plan and the step-by-step guide — is also in
the repo, including a "what the plan got wrong" retrospective.
