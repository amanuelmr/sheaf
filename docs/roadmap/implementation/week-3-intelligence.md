# Week 3 — Intelligence, with evidence (`v0.4.0`)

Goal: documents arrive with fields filled in, and accuracy is a number in the README.
Implements [ADR 0010](../../adr/0010-extraction-behind-a-provider-port-with-evals.md).

**The key reuse.** The server already serves `GET /v1/documents/{sha}/suggestions`
from `suggestions_json`. The phone's engine already fetches suggestions
(`fetchSuggestions` → `SuggestionsReceived`) and accepts them (`acceptMetadata`).
So when native extraction writes its result where Paperless suggestions used to
go, **the existing phone flow lights up with no protocol change.**

---

## 3.1 `packages/extract`: schema and pure normalisers (≈3 h)

### Files

- New package `packages/extract` (`package.json` named `@sheaf/extract`, `src/index.ts`),
  added to `tsconfig.json` references and to the ingest `Dockerfile` COPY/symlink
  list.
- `eslint.config.mjs`: add `packages/extract/src/**` to the block that bans
  `Date.now()` / `Math.random()`.

### Schema (`src/schema.ts`)

```ts
export const SCHEMA_VERSION = 1;
export interface Field<T> {
  readonly value: T;
  readonly confidence: number;
} // 0..1
export interface Money {
  readonly minor: number;
  readonly currency: string;
} // 1234 + 'EUR' = €12.34
export interface ExtractedFields {
  readonly title?: Field<string>;
  readonly date?: Field<string>; // ISO yyyy-mm-dd
  readonly correspondent?: Field<string>;
  readonly documentType?: Field<string>;
  readonly total?: Field<Money>;
  readonly tags?: Field<readonly string[]>;
}
```

Money is **integer minor units**, never floats.

### Normalisers (`src/normalise.ts`), all pure

- `parseDate(raw, order: 'DMY' | 'MDY' | 'YMD', pivotYear)` → ISO or `null`.
  Handles `2026-10-05`, `05/10/2026`, `5.10.26`, `5 Oct 2026`, `October 5, 2026`.
  Ambiguous `05/10/2026` is resolved by `order` (from `SHEAF_DATE_ORDER`, default
  `DMY`). Rejects impossible dates (`31/02`).
- `parseMoney(raw, defaultCurrency)` → `Money | null`. Handles `€12,50`,
  `1.234,56 EUR`, `$1,234.56`, `12.50`, `-3.00`, `CHF 1'234.50`. The rule for `,`
  vs `.`: the last separator followed by exactly two digits is the decimal mark.
- `normaliseName(raw)` → for comparing correspondents: NFKC, lowercase, strip
  punctuation and legal suffixes (`ltd`, `gmbh`, `inc`, `llc`, `sdn bhd`, ...).
- `matchVocabulary(candidate, names)` → best existing name with similarity ≥ 0.85
  (normalised Levenshtein ratio), else `null`. This keeps "ACME Ltd." and "Acme"
  from becoming two correspondents.

### Tests first

Table-driven tests for every format above plus the nasty ones: `1,000` (thousand,
not one), `0,5`, a year-only date, Unicode digits, empty input. Target 100%
statement coverage and add `packages/extract` to the coverage floors in
`vitest.config.ts`, like `core`.

**Acceptance.** `pnpm test` green; coverage floor enforced.

---

## 3.2 The `Extractor` port and three providers (≈3 h)

### Port (`packages/extract/src/extractor.ts`)

```ts
export interface ExtractionInput {
  readonly text: string;
  readonly vocabulary: {
    correspondents: readonly string[];
    documentTypes: readonly string[];
    tags: readonly string[];
  };
}
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}
export interface Extraction {
  readonly fields: ExtractedFields;
  readonly usage: Usage;
  readonly model: string;
}
export interface Extractor {
  readonly name: 'heuristic' | 'claude' | 'ollama';
  readonly version: number; // bump on any prompt or rule change
  extract(input: ExtractionInput): Promise<ApiResult<Extraction>>;
}
```

Every provider post-processes through the 3.1 normalisers, so all three produce
values in the same form. An LLM saying "Oct 5th" becomes `2026-10-05` the same way
the regex's output does.

### `heuristic` (default; no network)

- **Date**: all date-looking tokens → prefer one on a line containing
  `date|datum|fecha|invoice|issued`; else the most recent that is not in the future
  (pass `today` in, keeping it pure).
- **Total**: amounts on lines matching `total|amount due|balance|sum|gesamt|summe`;
  prefer the last such line; else the largest amount.
- **Correspondent**: first 5 non-empty lines, skip lines that are mostly digits,
  `matchVocabulary` against known names, else the longest line in title case.
- **Type**: keyword map (`receipt`, `invoice`, `bill`, `statement`, `contract`, ...).
- **Title**: `${correspondent} ${type} ${date}` with whatever is known.
- Confidence: fixed per rule (e.g. 0.9 for a labelled total, 0.5 for "largest
  amount"). Calibration is a stretch goal; consistency is what matters now.

### `claude` (opt-in, `SHEAF_EXTRACTOR=claude`, `ANTHROPIC_API_KEY`)

Plain `fetch` to `https://api.anthropic.com/v1/messages` (no SDK, to keep the
server dependency-free):

- headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`
- model: `SHEAF_CLAUDE_MODEL`, default `claude-haiku-4-5-20251001`
- `temperature: 0`, `max_tokens: 1024`
- **Force structured output with one tool**: `tools: [{ name: 'record_fields',
input_schema: <JSON Schema of ExtractedFields with value+confidence> }]`,
  `tool_choice: { type: 'tool', name: 'record_fields' }`. Read the `tool_use`
  block's `input`. Validate it by hand (types, ranges); invalid → `err(rejected)`.
- System prompt: the task, the date order, "prefer a name from this list when it is
  the same organisation", then the vocabulary. Mark the system block with
  `cache_control: { type: 'ephemeral' }` so the vocabulary is prompt-cached across
  documents, which cuts the cost of a backlog.
- Truncate document text to ~12,000 characters (the head and tail of a long document
  carry most fields; keep both).
- Cost: compute from `usage` in the response and a price table in code, labelled
  with the date it was checked.
- Map HTTP failures with `classifyResponse` from `@sheaf/http`: 429 and 5xx stay
  retryable, 400 and 401 do not.

### `ollama` (opt-in, local)

`POST {SHEAF_OLLAMA_URL}/api/chat` with `stream: false`, `format: <the same JSON
Schema>` (Ollama's structured outputs), model from `SHEAF_OLLAMA_MODEL`.

### The `extract` step (`services/ingest/src/steps/extract.ts`)

- `version`: `extractor.version * 100 + SCHEMA_VERSION`, so a prompt change or a
  schema change both re-process.
- `after: ['ocr']`, tolerating `given_up`. `applies`: the document has text.
- `run`: load text and vocabulary → `extract` → in one transaction:
  1. upsert `extractions (sha256, version, provider, model, fields_json, usage_json, created_at)` (migration 6)
  2. write machine values into `fields (sha256, name, value_json, source, confidence, updated_at)`
     **only where the existing row is not `source='user'`**:
     ```sql
     INSERT INTO fields (...) VALUES (...)
     ON CONFLICT(sha256, name) DO UPDATE SET value_json = excluded.value_json, ...
     WHERE fields.source = 'machine';
     ```
  3. write `suggestions_json` (title, date, correspondent, documentType, tags), so
     `GET .../suggestions` and therefore the phone get it
  4. upsert names into `names`; `reindex(sha256)`
- `PATCH /v1/documents/{sha}` (existing route) now also writes `fields` with
  `source='user'`. This is the rule that user edits win.

### Tests

- **One parametrised suite run against every provider**, using recorded responses
  (next point): the output is normalised, invalid model output is rejected, and HTTP
  errors are classified correctly.
- **Record/replay transport** (`packages/extract/test/recorder.ts`): wraps `fetch`;
  in `record` mode it saves `{request, response}` to
  `test/recorded/<provider>/<sha256 of request body>.json`; in `replay` mode it
  serves them and **fails if a request has no recording**. CI always replays, so no
  API key is needed in CI.
- Step tests: user-edited fields survive re-extraction; a version bump re-extracts.

**Acceptance.** With `SHEAF_EXTRACTOR=heuristic`, a scanned receipt shows a
suggested title/date/total on the phone within seconds of syncing. With `claude`
the same, and `extractions` has cost and latency recorded.

**Traps.**

- The phone reads `suggestions: null` as "not yet" and maps it to a retryable
  `unreachable` (`SheafAdapter.getSuggestions` in `apps/mobile/src/adapters/api.ts`),
  so it keeps asking with backoff. But the suggestions side task has a **budget**:
  if extraction is slow (OCR grace period plus a provider backlog), the phone can
  abandon before an answer exists. Two fixes, do both: when the extract step
  `given_up`s, write `suggestions_json = '{}'` (an answer of "nothing", which stops
  the polling cleanly), and check the side-task budget in `@sheaf/core` covers at
  least ~15 minutes of backoff. If it doesn't, raise it in a tested change.
- Never log document text or the API key. The existing `redact` in `@sheaf/http`
  shows the pattern.
- `cache_control` only pays off above the minimum cacheable prompt length; with a
  tiny vocabulary it has no effect. That's fine, just don't claim savings you didn't
  measure.

---

## 3.3 Eval harness (≈4 h)

This is the step that sets the project apart for AI roles. Keep it rigorous and small.

### Data

- `packages/extract/eval/` (gitignored `cache/`):
  - `fetch-sroie.ts` downloads the SROIE task 3 test set (receipt OCR text plus
    `company/date/address/total` labels) into `cache/`. **Do not commit the dataset.**
    Its licence is research-oriented. Commit only the script and your results.
  - Take a fixed, seeded sample of 50 receipts. Store the chosen ids in
    `eval/sroie-sample.json` (ids only).
  - `own/`: ~30 of your own documents (receipts, letters, invoices) as **text files
    plus labels** in `own/labels.jsonl`. Redact anything personal before committing,
    or keep `own/` out of git and commit only aggregate scores.
- Golden line format:
  `{"id":"sroie-X51005433522","text":"...","expected":{"correspondent":"...","date":"2018-03-09","total":{"minor":2990,"currency":"MYR"}}}`

### Scoring (`eval/score.ts`, pure)

Per field:

- `date`, `total`: exact match after normalisation (that is why 3.1 comes first).
- `correspondent`: exact after `normaliseName`, and **fuzzy** (token-set F1 ≥ 0.8)
  reported separately. SROIE company strings are long legal names.
- Missing prediction counts as wrong; report coverage (how often a value was
  returned at all) next to accuracy.

### Runner (`eval/run.ts`, `pnpm eval [--provider=...] [--record]`)

For each provider: run every golden document (concurrency 4), collect predictions,
usage and latency, then write:

- `eval/report.md`: one table per dataset, rows = providers, columns = per-field
  accuracy, coverage, mean cost/doc, p50/p95 latency; plus the 10 worst misses per
  field with expected vs got.
- `eval/results.json`: machine-readable scores.

### CI gate

- `eval/baseline.json` checked in (copied from a good `results.json`).
- `.github/workflows/ci.yml`: a step `pnpm eval --replay --check` that fails if any
  field's accuracy is more than 2 points below baseline for any provider.
- Updating the baseline is a deliberate commit that says why.

**Acceptance.** `report.md` committed with real numbers for heuristic and Claude
(and Ollama if you have it); CI fails when you deliberately break a regex.

**What to write in the README.** One table, plus an honest sentence about what the
numbers do and do not mean: a 50-receipt sample, mostly Malaysian receipts from
2017–18 in SROIE, plus a handful of your own.

---

## 3.4 Inbox on the phone (≈3 h)

The README has promised "swipe to accept a suggestion, tap to correct it" since the
first commit. Build it on what already exists.

### Files

- New screen `apps/mobile/app/inbox.tsx`; link it from the outbox header with a
  count badge.
- Projection in `packages/store` (next to `pendingCount`):
  `awaitingReview(outbox)` = documents with `status === 'SYNCED'`,
  `suggestions !== null`, `metadata === null`. Test it in
  `packages/store/test/projections.test.ts`.
- Row: thumbnail, suggested title, date, total, correspondent; **Accept** (calls
  the existing `engine.acceptMetadata(docId, suggestionsAsPatch)`) and **Edit**
  (opens the existing `app/document/[id].tsx` prefilled).
- Swipe: add `react-native-gesture-handler` (`expo install`), use
  `ReanimatedSwipeable` (Reanimated 4 is already installed). Swipe right accepts,
  swipe left opens edit. **Buttons stay visible**: swipe is a shortcut, not the only
  way (accessibility).
- Haptic on accept (`expo-haptics` is already used by the shutter).

### Tests

- Projection unit tests.
- Maestro flow `e2e/inbox.yaml`: capture (fixture scanner) → wait → inbox shows 1 →
  accept → inbox empty → kill and relaunch app → still empty, and the server's record
  has the title (`GET /v1/documents/{sha}` from a Maestro `runScript`, or check by
  hand).

**Acceptance.** Accept and edit both persist across a restart and reach the server.

---

## 3.5 Extraction cost and latency metrics (≈1 h, ✂)

Record `sheaf_extraction_cost_usd_total{provider}`,
`sheaf_extraction_latency_seconds{provider}` (histogram), and
`sheaf_extraction_total{provider,outcome}`. If 4.3 hasn't landed yet, put the
counters in a tiny in-memory registry now (4.3 renders it).

---

## End of week 3

- ADR 0010 → accepted. README gains the eval table.
- `CHANGELOG.md` → `0.4.0`; tag `v0.4.0`.
