# 01 — Research: market, technology, and what it means for Sheaf

Research done 2026-10-05. Each section ends with the decision it drives. Sources are
at the bottom.

## 1. The market moved: Paperless-ngx v3 now has AI

Paperless-ngx 3.0 (released 2026-07-22) shipped "Paperless AI": LLM suggestions,
RAG chat over documents, embeddings (sqlite-vec), a Tantivy search backend, document
versions, and a redesigned tasks API. It also dropped API versions below 9. 3.1
added an "apply AI suggestions" workflow action and a remote-OCR option.

The community had already built the same idea as add-ons — **paperless-gpt**
(LLM titles/tags/correspondents, LLM OCR, via OpenAI/Ollama/Anthropic/Mistral) and
**paperless-AIssist** (vision OCR, auto-classification).

**Implication.** "Classify later using Paperless's suggestions" (ADR 0003) is no
longer a differentiator; it is now Paperless's own feature. Competing with Paperless
on DMS features is a losing fight. Sheaf's defensible ground is what Paperless
structurally does not do: **the edge** — capture, offline, exactly-once delivery,
on-device intelligence — and **owning the record** so it works without Paperless.

**Also:** the redesigned v3 tasks API was a compatibility risk for
`packages/paperless/src/tasks.ts`. The contract suite runs against a **pinned**
version (3.2.1, the one it passes) and, weekly, against `latest` as an early
warning. Result: 11/11 against 3.2.1 with no client change, so the v3 redesign did
not touch anything Sheaf reads. `PAPERLESS_IMAGE` points the suite at any other
version. Treat a red contract run as an expected task, not a surprise.

## 2. Competitors on the phone

| App                         | Platform | What it is                                                       | Gap Sheaf fills                                                  |
| --------------------------- | -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Swift Paperless             | iOS      | Polished native client: browse, edit, share links, custom fields | Online client of Paperless; no durable offline outbox            |
| Paperless Mobile            | Android  | Full client; scan with preset metadata                           | Metadata form _before_ upload — the exact friction Sheaf removes |
| Receipt Wrangler, TaxHacker | Mixed    | Receipt/expense-specific, LLM extraction (TaxHacker)             | Vertical tools; not general capture, not offline-first           |
| Papermerge, Stirling PDF    | Web      | DMS / PDF toolkit                                                | Server-side only                                                 |

**Implication.** No one owns "capture that cannot lose a page, works offline, and is
useful on its own". That is the positioning line.

## 3. Server-side OCR options

| Engine                | Shape                                                                | Fit for Sheaf                                                           |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OCRmyPDF + Tesseract  | CLI, CPU, adds invisible text layer to PDF; what Paperless uses      | **Default fallback.** Boring, proven, CPU-only, sidecar container.      |
| Docling (IBM)         | Layout + VLM ensemble, markdown out, GPU recommended, 1–2 GB weights | Good for structure/RAG; too heavy as default. Optional adapter.         |
| olmOCR / Qwen-VL      | 7B VLM, NVIDIA GPU                                                   | Best on tables; out of scope for a home server default.                 |
| Apple Vision / ML Kit | On-device, free, already integrated (`expo-ocr-kit`)                 | **Primary.** The phone already OCRs every page (`packages/outbox-ocr`). |

Character accuracy among the open-source engines clusters at 95–97% on clean text;
layout handling is the real differentiator, and receipts are mostly single-column.

**Decision.** _Edge-first OCR_: the phone already runs Vision/ML Kit right after
capture, so upload that text alongside the PDF and the server is searchable at once
with zero server compute. An OCRmyPDF worker is the fallback for documents that
arrive without text (web upload, email, old Android). See
[ADR 0009](../adr/0009-edge-first-ocr.md).

## 4. Search without adding a database

Verified locally on Node 24.21 (`node:sqlite`): **FTS5 virtual tables and BM25
ranking work out of the box, and `loadExtension` is available** with
`allowExtension: true`. So:

- Lexical: SQLite **FTS5** (BM25). Zero new dependencies; fits the ingest server's
  "no third-party runtime dependencies" rule (see its Dockerfile).
- Semantic (stretch): **sqlite-vec** as a loadable extension, same file.
- Hybrid: **Reciprocal Rank Fusion** of the two lists in JS — the approach Simon
  Willison documented, and the one a 2026 paper ("SQLite is Enough") benchmarks.

Note the phone keeps plain `LIKE` (ARCHITECTURE.md explains the `expo-sqlite` FTS5
regressions); this only changes the server.

## 5. AI extraction: structured output plus evals

- Schema-first extraction (title, date, correspondent, type, total, currency, tags),
  via the provider's JSON-schema / tool-use structured output. Providers sit behind a
  port: **Claude API** (default: `claude-haiku-4-5` for cost, `claude-sonnet-5-5` for
  hard cases), **Ollama** for fully local, **none** for a deterministic heuristic.
- **On-device option (stretch):** Apple's Foundation Models framework (iOS 26, ~3B
  model, `@Generable` structured output, 4K-token on-device context) can do
  extraction with nothing leaving the phone. Fits Sheaf's privacy story perfectly; a
  native module is the cost.
- **Evals are the differentiator.** Most "AI document" projects have none. Public
  receipt sets — **SROIE** (626 train / 347 test; company, date, address, total) and
  **CORD** (800/100/100, 30 subfields) — plus ~30 of your own labelled scans make a
  golden set. Report per-field exact-match and normalised-match, cost per document
  and latency, and run it in CI against recorded responses (no API key needed in CI).
  KIEval (2025) is a reference for scoring key-information extraction properly.

**Decision.** [ADR 0010](../adr/0010-extraction-behind-a-provider-port-with-evals.md).

## 6. Local-first and sync

The 2026 tooling (ElectricSQL, PowerSync, Replicache, CRDTs) solves _multi-writer
replicated state_. Sheaf's problem is different: a **single-writer append-only log
per device**, shipping immutable content-addressed blobs. That needs no CRDT; the
existing design is the right one and simpler than any of those frameworks.

**Decision.** Do not adopt a sync framework. Say why in the README — knowing when
_not_ to use CRDTs is a stronger signal than using one.

## 7. Mobile testing and release

- **Maestro** (1.40, Aug 2026) is the de facto E2E tool for Expo/RN: YAML flows,
  automatic waits, supports New Architecture and EAS builds; Maestro Cloud has a free
  tier and a GitHub Action.
- **EAS Build** for Android and iOS artefacts without a local Android toolchain.

**Decision.** One Maestro smoke flow (connect → capture from fixture → outbox shows
synced) in week 1; TestFlight/Play internal testing is a stretch.

## Sources

- Paperless-ngx release notes: https://releasebot.io/updates/paperless-ngx
- Paperless v3 breaking changes discussion: https://forum.cloudron.io/topic/15640/paperless-v3-breaking-changes/2
- Swift Paperless: https://apps.apple.com/app/swift-paperless/id6448698521
- Paperless Mobile (F-Droid): https://f-droid.org/packages/de.astubenbord.paperless_mobile/
- paperless-gpt: https://server.camp/docs/en/services/paperless-ngx/paperless-gpt/
- paperless-AIssist: https://hub.docker.com/r/nyxtronlab/paperless-aissist
- Self-hosted receipt/expense tools: https://selfhostyourself.com/alternative-to/expensify
- Open-source OCR 2026 overview: https://unstract.com/?p=16249 and https://imagetotable.ai/blog/best-open-source-ocr-tools-2026
- JabRef ADR on OCR engine selection: https://devdocs.jabref.org/decisions/0056-OCR-engine-selection.html
- Hybrid FTS5 + sqlite-vec with RRF (Simon Willison): https://simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite/
- "SQLite is Enough" (arXiv 2608.24060): https://arxiv.org/pdf/2608.24060
- Apple Foundation Models framework guide: https://createwithswift.com/exploring-the-foundation-models-framework/
- KIEval: https://arxiv.org/pdf/2503.05488
- LLM key-value extraction benchmark in noisy documents (arXiv 2609.17538): https://arxiv.org/pdf/2609.17538
- Receipt understanding with MLLMs: https://www.alphaxiv.org/abs/2605.22413
- Local-first with SQLite in production (2026): https://noqta.tn/blog/local-first-software-architecture-sqlite-production-2026
- Maestro with Expo (2026): https://reactnativerelay.com/pl/article/maestro-e2e-testing-react-native-2026-kompletny-przewodnik-dla-expo
- Maestro + EAS reference repo: https://github.com/lingvano/react-native-eas-maestro
