# Week 2 — Standalone (`v0.3.0`)

Goal: `docker compose up` with **no Paperless** gives you capture and search.
Implements [ADR 0007](../../adr/0007-sheaf-is-the-system-of-record.md) and
[ADR 0009](../../adr/0009-edge-first-ocr.md).

Order matters this week: 2.1 → 2.2 → 2.3 → 2.4 → 2.5. Step 2.6 can happen any time after 2.1.

---

## 2.1 Durable job table and runner (≈4 h)

**Why.** OCR, extraction and later steps each need what the forwarder already has —
state, attempts, backoff, a terminal state — and copying those columns onto
`documents` once per step (as `suggestions_*` already did) does not scale. One table,
one runner.

**Scope decision.** The `Forwarder` is **not** moved into the job runner. It has a
subtler state machine (a task id, adopting a lost hand-off) with its own simulator,
and it works. The runner is for steps whose result is a pure function of the
document: run it again and you get the same answer.

### Files

- New: `services/ingest/src/jobs.ts` (runner + `Step` type)
- New: `services/ingest/src/migrations.ts` (see below; used from here on)
- Modified: `services/ingest/src/storage.ts` (expose the driver to the runner, or
  add job queries here — keep SQL in one place: prefer `storage.ts`)
- Modified: `services/ingest/src/main.ts` (start the runner's interval, same
  "skip if still running" shape as the forwarder's)
- New tests: `services/ingest/test/jobs.test.ts`, `services/ingest/test/job-sim.test.ts`

### Migrations, introduced now

`Storage.open` adds columns by comparing against `PRAGMA table_info`. That stays for
the old columns. New tables need ordered, run-once migrations:

```ts
// migrations.ts
export const MIGRATIONS: ReadonlyArray<{ id: number; sql: readonly string[] }> = [
  { id: 1, sql: [/* jobs table */] },
  // 2.2 adds deliveries, 2.3 document_text, 2.4 documents_fts, ...
];
// applyMigrations(driver): CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY, applied_at INTEGER);
// for each id not present: run its statements inside BEGIN/COMMIT, then insert the id.
```

### Schema

```sql
CREATE TABLE jobs (
  sha256      TEXT    NOT NULL,
  step        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  state       TEXT    NOT NULL CHECK (state IN ('pending','running','done','given_up')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (sha256, step, version)
);
CREATE INDEX jobs_due ON jobs (state, next_at);
```

### The `Step` contract

```ts
export interface Step {
  readonly name: string; // 'ocr', 'extract', ...
  readonly version: number; // bump to re-process every document
  /** Steps that must be 'done' (or 'given_up', if `tolerates` says so) first. */
  readonly after: readonly string[];
  /** Earliest time this step may run for a document, e.g. an OCR grace period. */
  notBefore?(doc: DocumentRecord): number;
  /** Whether this document needs the step at all (e.g. OCR only without text). */
  applies(doc: DocumentRecord, ctx: StepContext): Promise<boolean>;
  /** Must be idempotent: write results keyed by (sha256, version), upsert. */
  run(doc: DocumentRecord, ctx: StepContext): Promise<ApiResult<void>>;
}
```

### Runner algorithm (`JobRunner.tick(now, jitter)`)

1. **Enqueue**: for each step, `INSERT OR IGNORE INTO jobs (...) SELECT sha256, ?, ?, 'pending', 0, ?, ? FROM documents WHERE <no row for this step@version>` — bounded with `LIMIT 100` per tick.
2. **Recover**: rows left `running` by a dead process become `pending`. Safe _only_
   because `run` is idempotent — state this in a comment, and test it.
3. **Pick due**: `state='pending' AND (next_at IS NULL OR next_at <= now)`, whose
   `after` steps are finished, oldest first, `LIMIT 20`.
4. **Run**: mark `running` → call `step.run` →
   - `ok` → `done`, `finished_at = now`
   - `err(reason)` retryable → `pending`, `attempts+1`, `next_at = now + backoffMs(attempts, jitter)` (reuse `@sheaf/core`)
   - `err(reason)` non-retryable, or attempts over the step's budget → `given_up`, `last_error = describe(reason)`
   - **throws** → let it propagate (ADR 0005); the row stays `running` and step 2 recovers it.

### Tests first

- `re-running a done job does nothing` (spy step counts calls)
- `bumping a step version enqueues every document again, keeps the old rows`
- `a step whose 'after' is not done is not picked`
- `a retryable failure backs off; a non-retryable one gives up`
- `a crash (throw) mid-run leaves the job recoverable and it completes on the next tick`
- **job-sim**: copy the construction of `test/forward-sim.ts` — real `Storage`,
  `virtualClock`, seeded `rng` from `@sheaf/sim` — with two fake steps that fail at
  random and a kill (throw) injected between marking `running` and recording the
  outcome. Assert over 200 seeds: every job ends `done` or `given_up`, and each
  fake step's side effect happened at least once and is recorded once.

**Acceptance.** Tests above green; runner ticking in `main.ts` with no steps yet
registered (harmless).

---

## 2.2 Connector port, Paperless behind it (≈3 h)

### Files

- Rename: `ForwardTarget` → `Connector` in `services/ingest/src/forwarder.ts`; add
  `readonly name: string`. Keep a `type ForwardTarget = Connector` alias for one
  release so the diff stays small.
- Modified: `paperless-target.ts` → returns `{ name: 'paperless', ... }`
- New migration (id 2): `deliveries` table, and the copy from old columns
- Modified: `storage.ts` — `dueForForwarding(now, connector)`,
  `recordForwardAttempt(sha, connector, update)`, `forwardTaskId(sha, connector)`,
  `forwardCounts(connector)` read/write `deliveries`
- Modified: `retention.ts`, `suggestion-fetcher.ts` (both read forwarding state)
- Modified: `main.ts` — build a `Connector[]` from env; one `Forwarder` per connector
- Modified: `compose.yml` split (below)
- Tests: existing `forwarder.test.ts`, `forward-convergence.test.ts`,
  `retention.test.ts` must pass with **only mechanical changes** (constructor args).

### Schema and data migration

```sql
CREATE TABLE deliveries (
  sha256    TEXT NOT NULL,
  connector TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'pending',
  attempts  INTEGER NOT NULL DEFAULT 0,
  next_at   INTEGER,
  task_id   TEXT,
  remote_id TEXT,
  error     TEXT,
  done_at   INTEGER,
  PRIMARY KEY (sha256, connector)
);
-- Carry history forward, once, only if forwarding ever happened:
INSERT OR IGNORE INTO deliveries
  SELECT sha256, 'paperless', forward_state, forward_attempts, forward_next_at,
         forward_task_id, remote_id, forward_error, forward_done_at
    FROM documents
   WHERE forward_state <> 'pending' OR forward_attempts > 0;
```

Old `forward_*` columns stay (unread). Dropping them buys nothing and risks a
migration bug.

New documents get a `deliveries` row per **configured** connector at `PUT` time
(inside `Storage.put`, `INSERT OR IGNORE`). When a connector is added later, a
startup backfill inserts `pending` rows for existing documents — make that an
explicit env opt-in (`SHEAF_BACKFILL_CONNECTORS=1`), since it could mean uploading
thousands of documents.

### Fixture database test (do this first)

Generate a database with the **current** code before changing anything:

```bash
SHEAF_DATA_DIR=services/ingest/test/fixtures/v0.2-db SHEAF_TOKEN=... pnpm --filter @sheaf/ingest start
# PUT a few documents, let a fake/real Paperless mark some done, stop the server
```

Commit `ingest.db` (not the objects). Test: open it with new `Storage.open`, assert
every `forward_*` value appears in `deliveries` for `'paperless'`, and
`/v1/health` reports the same counts as before.

### Retention changes meaning — handle it explicitly

Today retention frees bytes once Paperless has them. Under ADR 0007 Sheaf is the
record, so freeing bytes is only allowed when the operator names the connector
they trust as the archive:
`SHEAF_RETENTION_DAYS=30` **and** `SHEAF_RETENTION_CONNECTOR=paperless`. Retention
with no connector named refuses to start and logs why. Test both.

### Health stays compatible

`HealthResponse.forwarding` keeps its shape (the admin reads it), filled from the
`paperless` connector if present. Add an optional
`connectors?: Record<string, { counts: Record<string, number> }>` for the web app.

### Compose split

- `compose.yml`: `ingest` only (plus `ocr` after 2.6). Remove `depends_on: paperless`
  and the required `PAPERLESS_ADMIN_PASSWORD` — today standalone **cannot start**
  without it because of `:?`.
- `compose.paperless.yml`: `paperless`, `broker`, and an `ingest` override that sets
  `PAPERLESS_URL`, credentials and `depends_on`.
- Usage: `docker compose -f compose.yml -f compose.paperless.yml up -d`. Update
  README and the comment header in both files.

**Acceptance.** All existing ingest tests pass; fixture DB migrates; standalone
compose starts with only `SHEAF_TOKEN` set; Paperless compose still forwards.

---

## 2.3 Edge text: the phone uploads its OCR (≈3 h)

The phone already recognises text after capture (`apps/mobile/src/adapters/ocr.ts`
→ `@sheaf/outbox-ocr`) and deletes it on release. Send it to the server first.

### Protocol (`packages/protocol/src/index.ts`)

```ts
paths.documentText = (sha256: string) => `/${PROTOCOL_VERSION}/documents/${sha256}/text`;
export const MAX_TEXT_BYTES = 1024 * 1024;
export interface DocumentTextBody {
  readonly source: 'edge';
  readonly engine: string; // 'apple-vision' | 'mlkit' — from Platform.OS
  readonly text: string;
}
```

`PUT` → `204` (stored or identical), `404` unknown document, `413` too large,
`400` malformed. Idempotent upsert by `(sha256, source)`. Add protocol tests.

### Server

- Migration 3: `document_text (sha256, source, engine, text, received_at, PRIMARY KEY (sha256, source))`.
- Router: route the `/text` suffix like `/suggestions` is routed today.
- After storing text, call `reindex(sha256)` (2.4) — until 2.4 lands, a no-op.

### Client (`packages/client/src/client.ts`)

`putText(sha256, body): Promise<ApiResult<null>>`, mirroring the existing methods
(same timeout, same token redaction). Tests with an injected `fetch` like the
existing client tests.

### Core: a third side task (the careful part)

Text upload is post-sync work, so it gets the same discipline as suggestions and
metadata (invariant 4). And **release must wait for it**, or the phone deletes the
OCR row before it was sent.

- `events.ts`:
  - `SideTask = 'suggestions' | 'metadata' | 'text'`
  - New events: `TextRecognized { docId, at }` (local text now exists),
    `TextUnavailable { docId, at }` (OCR finished with nothing), `TextUploaded { docId, at }`
  - `Captured` gains optional `ocrPending?: true`. Absent in old logs → treated as
    "no OCR expected", so old logs replay exactly as before.
- `state.ts`: `text: 'none' | 'pending' | 'available' | 'uploaded'`, plus
  `side.text: SideTaskState`.
- `reduce.ts`: the obvious transitions; `SideTaskFailed` with `task: 'text'` uses
  the existing `sideTaskFailed` helper.
- `machine.ts`, in `SYNCED`, after metadata and suggestions:
  ```ts
  if (state.remoteId !== null && state.text === 'available') {
    const due = sideTaskDue(state.side.text, tick.now);
    if (due === 'now') return { type: 'uploadText', docId };
    if (due !== 'abandoned') return { type: 'wait', docId, untilMs: due };
  }
  ```
  And `releaseLocalFiles` additionally requires `textSettled`:
  `text ∈ {none, uploaded}` **or** `side.text.abandoned !== null` **or**
  (`text === 'pending'` and `tick.now - capturedAt > 10 min`). The last clause
  stops a crash during OCR from holding the local copy for ever. It's pure because
  `now` is a parameter.
- `Command` gains `{ type: 'uploadText'; docId }`.

### Engine (`packages/engine`)

- `EngineApi.putText?(state: DocState, text: string): Promise<ApiResult<null>>`
  (optional, like `pollTask`).
- New optional port `EnginePorts.text?: { read(docId: DocId): Promise<string | null> }`.
- `perform('uploadText')`: read text → `null` means it vanished, so append
  `TextUnavailable` → else call `putText` → `TextUploaded` or `SideTaskFailed`.

### Mobile

- `packages/engine/src/engine.ts`: `CaptureInput` gains `ocrPending?: true`, copied
  onto the `Captured` event in `capture()`.
- `app/index.tsx` `commit()`: pass `ocrPending: true` into `capture`.
- `adapters/ocr.ts` `extractAndSaveText`: after saving, append `TextRecognized`
  (or `TextUnavailable` if no page produced text) through the store. It needs the
  store handle passed in; `SyncService` already owns it.
- `adapters/api.ts` `SheafAdapter.putText` → `client.putText`.
- `runtime/app-context.tsx`: wire `text: { read: (id) => get(driver, id) }`.

### Tests first

- `machine.test.ts`: the exhaustive "never upload from AWAITING_SERVER" test still
  passes; new: text uploads only when `SYNCED` and `available`; release waits for
  text; release proceeds after 10 minutes of `pending`.
- `crash-recovery.test.ts`: logs with the new events truncated at every boundary
  stay valid.
- **Old logs**: a fixture log without `ocrPending` replays to the identical state
  as before the change (snapshot the `DocState`).
- `packages/sim`: give `fake-sheaf.ts` a `putText` with injected faults; assert at
  convergence that every document whose fake OCR produced text has it on the server.

**Acceptance.** Scan a receipt on the phone, then `sqlite3 .sheaf-data/ingest.db
"select engine, substr(text,1,80) from document_text"` shows its words.

---

## 2.4 Full-text search: FTS5 and `GET /v1/search` (≈3 h)

Verified: Node 24's `node:sqlite` ships FTS5 with `bm25()` (see research §4).

### Schema (migration 4)

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  sha256 UNINDEXED, title, correspondent, document_type, tags, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

A standalone FTS table maintained by one function, **not** triggers across four
tables. `Storage.reindex(sha256)` deletes and re-inserts one row from the current
`documents` + all `document_text` rows (concatenated). Call it from the end of
`put`, `putText`, `patch`, and (week 3) extraction saves, inside the same
transaction. On startup: if `count(documents_fts) < count(documents)`, reindex the
missing ones in batches of 200.

### Query building (pure, in `services/ingest/src/search-query.ts`)

Never pass user input straight to `MATCH`. FTS5 syntax errors throw, and a colon
means "column filter". This is the same bug that makes Paperless return 400 on a
colon (README, contract tests). Turn input into safe terms:

```ts
export function toMatch(input: string): string | null {
  const terms =
    input
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' AND ');
}
```

Test it with colons, quotes, `AND`/`OR`/`NEAR` words, emoji, an empty string and
2,000 characters.

### Endpoint

`GET /v1/search?q=&limit=20&offset=0` →

```ts
export interface SearchHit {
  readonly sha256: string;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly receivedAt: number;
  readonly snippet: string;
  readonly score: number;
}
export interface SearchResponse {
  readonly hits: readonly SearchHit[];
  readonly hasMore: boolean;
}
```

SQL: `SELECT d.*, snippet(documents_fts, 5, '«', '»', '…', 12) AS snippet,
bm25(documents_fts, 0, 10, 5, 5, 3, 1) AS score FROM documents_fts JOIN documents d
USING (sha256) WHERE documents_fts MATCH ? ORDER BY score LIMIT ? OFFSET ?` (BM25 is
lower-is-better). The weights rank title above body.

### Tests

- Router: word from the body finds the document; title match outranks body match;
  `q` of only punctuation returns `{hits: []}`, not 500.
- **Benchmark** (`search.bench.test.ts`): insert 10,000 synthetic documents with
  ~300 words each, run 50 queries, assert p95 < 50 ms (the 20 ms target is for
  your laptop; CI runners are slower). Print the measured numbers; they go in the README.

**Acceptance.** Search a word printed on a scanned receipt and it comes back first.

---

## 2.5 Native archive for the phone's library (≈2 h)

The phone's library screen calls `client.searchArchive`, `archiveVocabulary`,
`archiveThumbnailSource` against `/v1/archive*`, served by an `ArchiveSource`
(`services/ingest/src/paperless-browse.ts`). Give it a native implementation so the
app works with Paperless off, **without changing the app**.

### The id problem, solved with `rowid`

`ArchiveSource.get(id: number)` and the protocol (`PAPERLESS_ID_PATTERN`) use positive
integers. Native documents are named by sha256. SQLite already gives every
`documents` row a stable integer `rowid`. Use it as the archive id. No protocol change.

### Vocabulary

`ArchivePatch` sets correspondent/type/tags **by id**. Migration 5 adds
`names (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, UNIQUE(kind, name))`.
Upsert names whenever a document's fields are written; `vocabulary()` lists them;
`patch(id, {correspondentId})` resolves id → name and writes the text column.

### Files

- New: `services/ingest/src/native-archive.ts` implementing `ArchiveSource`
  (`search` → the 2.4 query, or newest-first list when there is no text query;
  `get` → by rowid; `patch` → `storage.patch` + `reindex`; `contentSnippet` → first
  200 chars of text).
- `thumbnail(id)`: the server cannot render PDFs (no dependencies). Return
  `err({ kind: 'not_found' })` for now. The library already shows a placeholder.
  ✂ Optional follow-up: `PUT /v1/documents/{sha}/thumbnail` from the phone, which
  already makes a 320px JPEG in `makeThumbnail`. Same edge-first idea as 2.3.
- `main.ts`: `SHEAF_ARCHIVE_SOURCE=native|paperless`, default `native`. Router's
  `archive_disabled` path is now reached only if the operator chose `paperless`
  without configuring it.

### Tests

Run the existing router archive tests against **both** sources with one
parametrised suite, the same technique `packages/store` uses for its two log
implementations.

**Acceptance.** Stop Paperless (or never start it); the phone's library lists,
searches, opens and edits documents.

---

## 2.6 OCRmyPDF fallback container (≈2 h, ✂)

For documents with no edge text (web uploads later, old app versions, OCR failure).

### Files

- New: `services/ocr/Dockerfile`, based on the official OCRmyPDF image
  (`jbarlow83/ocrmypdf`), plus `services/ocr/server.py`: a ~40-line `http.server`
  that accepts `POST /ocr` (PDF body), runs
  `ocrmypdf --skip-text --sidecar out.txt in.pdf out.pdf`, returns `{ "text": ... }`.
  Python, because that is what the image has. It is a sidecar, not part of the
  Node server, which keeps zero dependencies.
- `compose.yml`: `ocr` service on an **internal network** (`internal: true`) with
  no published port; it never needs the internet. Run as non-root, with a memory
  limit.
- New step in `services/ingest/src/steps/ocr.ts`:
  - `applies`: no `document_text` row exists for the document
  - `notBefore`: `receivedAt + 120_000` (give edge text a two-minute head start)
  - `run`: `fetch(SHEAF_OCR_URL + '/ocr', { body: bytes })` → upsert
    `document_text(source='ocrmypdf')` → `reindex`
  - Registered only when `SHEAF_OCR_URL` is set.

### Tests

Step unit tests with an injected `fetch`. One manual check with a real image-only PDF.

**Acceptance.** A PDF uploaded with `curl -X PUT` and no text is searchable within
about three minutes.

---

## End of week 2

- ADRs 0007 and 0009 → `Status: accepted` with the date.
- `ARCHITECTURE.md`: replace the layer diagram with the one from
  `docs/roadmap/02-target-architecture.md`; add sections on jobs, connectors, search.
- `CHANGELOG.md` → `0.3.0`; tag `v0.3.0`.
