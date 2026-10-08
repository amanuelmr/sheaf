# 10. Field extraction behind a provider port, gated by evals

- Status: accepted
- Date: 2026-10-05 (accepted on implementation in steps 3.1–3.4)

## Context

Once Sheaf is the system of record (ADR 0007), it has to fill in title, date,
correspondent, type, amount and tags itself. LLMs do this well, but "well" is a
claim, and a prompt change can silently make it worse. Sending documents to a cloud
model is also a privacy decision the user must make, not the default.

## Decision

- An `Extractor` port with a fixed, versioned schema (fields, per-field confidence).
  Adapters: `heuristic` (regex and dictionaries; no network; **the default**),
  `claude` (structured output via tool use; `claude-haiku-4-5` by default),
  `ollama` (local models). Choosing a networked provider is explicit configuration,
  and the web app shows that documents leave the server.
- Extraction is a job keyed by `(sha256, extractor_version)`. Bumping the version
  re-processes in the background and keeps old results for comparison.
- Machine output never overwrites a field the user edited (`source: user`).
- An **eval harness** (`packages/extract/eval`) scores every adapter on a golden set:
  a sample of SROIE test receipts and ~30 of the author's own labelled scans.
  Metrics: per-field exact and normalised match, cost per document, p50/p95 latency.
  CI replays recorded responses (no API key) and fails if accuracy drops more than
  2 points against the checked-in baseline.

## Consequences

Accuracy becomes a number in the README rather than an adjective. The default install
sends nothing anywhere. Costs: maintaining a labelled set, and recorded fixtures that
need refreshing when a prompt changes. Measuring the regex extractor against the LLM
also stops "AI" from being added where a regex would do — the same discipline as
ADR 0003's amendment, which declined an enhancement filter that measured as a
regression.
