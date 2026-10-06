# Week 4 — A face, a pulse, the story (`v1.0.0`)

Goal: a two-minute reviewer is impressed; a two-hour reviewer is more so.
Implements [ADR 0008](../../adr/0008-device-pairing.md).

---

## 4.1 Device pairing (≈4 h)

### Schema (migration 7)

```sql
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,          -- random 16 bytes hex
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,      -- sha256(token) hex
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked_at  INTEGER
);
CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,          -- sha256(code) hex
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
ALTER TABLE documents ADD COLUMN device_id TEXT;   -- via ADDED_COLUMNS
```

### Protocol additions

| Route                     | Auth  | Body → response                                                                               |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `POST /v1/pairing-codes`  | admin | `{}` → `{ code, expiresAt, uri }` where `uri = sheaf://pair?server=<url-encoded>&code=<code>` |
| `POST /v1/pair`           | none  | `{ code, deviceName }` → `{ deviceId, token }` (token shown once)                             |
| `GET /v1/devices`         | admin | → `{ devices: [{ id, name, createdAt, lastSeen, revoked }] }`                                 |
| `DELETE /v1/devices/{id}` | admin | → `204` (sets `revoked_at`; idempotent)                                                       |

New `ErrorCode`s: `device_revoked` (401), `pairing_invalid` (400, used for expired,
used or unknown codes alike, so nothing leaks about which), `forbidden` (403).

### Auth in the router (`services/ingest/src/auth.ts`, pure-ish)

Replace the single `tokenMatches` check at the top of `handle` with:

```ts
type Principal = { kind: 'admin' } | { kind: 'device'; id: string };
async function authenticate(header, deps): Promise<Principal | 'unauthenticated' | 'revoked'>;
```

1. `SHEAF_TOKEN` match (keep `timingSafeEqual`) → admin.
2. Else `sha256(token)` → look up `devices.token_hash` (an exact lookup on a hash is
   not a timing oracle) → revoked? `'revoked'` : device.
3. Update `last_seen` at most once a minute per device (keep a small in-memory map).

Then an allow-list: admin-only routes are `/v1/pairing-codes`, `/v1/devices*` and
`/metrics`. `POST /v1/pair` is the only unauthenticated route besides `OPTIONS`.
`PUT /v1/documents/{sha}` records `device_id` on first store.

**Pairing codes**: 16 random bytes, base32 (easy to type if the QR fails), valid for
5 minutes, single use (set `used_at` in the same transaction that creates the device:
`UPDATE ... WHERE used_at IS NULL AND expires_at > ?` and check `changes === 1`).
Rate-limit `POST /v1/pair` to 10/minute per remote address in memory. With 128-bit
codes brute force is already hopeless; the limit just keeps logs clean.

### Phone

- `app/connect.tsx`: a **Scan pairing code** button (primary), with the manual
  URL/token form kept below as "Connect manually".
- QR scanning with `expo-camera`'s `CameraView` `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`
  and `onBarcodeScanned`. Parse with a pure `parsePairingUri(uri)` in
  `src/lib/pairing.ts` (unit-tested: wrong scheme, missing params, http vs https).
- **Deep link**: the `sheaf` scheme is already registered in `app.json`. Handle
  `sheaf://pair?...` with `expo-linking`, so scanning the QR with the system Camera app
  opens Sheaf straight into pairing.
- Call `POST /v1/pair` (new `SheafClient.pair`), then the existing
  `connect({ name, baseUrl, token })`. The token goes to SecureStore like today.
- **Revoked**: the engine already maps 401 to `BLOCKED`. Make `describe()` in
  `@sheaf/core` (or the adapter) recognise `device_revoked` and show
  "This phone was removed from the server. Pair it again to keep syncing." Nothing
  local is deleted; the outbox waits.

### Tests first

- Router: pair with valid code → token works for upload; same code twice → second
  fails; expired → fails; revoked device → 401 `device_revoked`; device token on
  `/v1/devices` → 403; admin token still uploads (old installs keep working).
- Storage: tokens and codes are never stored in plaintext (query the tables and
  assert no row contains the token).

**Acceptance.** Pair a real phone by QR in under 10 seconds; revoke it from the web
app (4.2) and see the message on the phone.

---

## 4.2 Web app (≈4 h)

### Rename and structure

```bash
git mv apps/admin apps/web
```

Update the package name to `@sheaf/web`, root `package.json` scripts
(`bundle:web`), CI step, and README links. Keep Vite and React; add only
`qrcode` (for the pairing QR). Use hash routing written by hand
(`#/search`, `#/doc/<sha>`, `#/inbox`, `#/devices`, `#/system`). Five routes don't
need a router library.

### Pages

1. **Search** (home): input with 200 ms debounce → `GET /v1/search`; result rows
   show title, correspondent, date and the snippet with `«»` turned into `<mark>`
   (escape everything else first: snippets contain document text).
2. **Document** `#/doc/<sha>`:
   - PDF: `GET /v1/documents/{sha}` with the token → `blob:` URL → `<iframe>`.
   - Fields with provenance: a "machine · 0.82" or "you" badge per field; inline edit
     → `PATCH`.
   - **Paper trail**: new `GET /v1/documents/{sha}/history` built on the server from
     timestamps that already exist: `received_at`, `document_text.received_at` per
     source, `jobs.finished_at` per step, `deliveries.done_at` per connector,
     `fields.updated_at` where `source='user'`. Sorted, rendered as a timeline.
3. **Inbox**: `GET /v1/inbox` (documents with machine fields and no user fields),
   keyboard driven: `j/k` move, `a` accept, `e` edit.
4. **Devices**: "Pair a phone" → `POST /v1/pairing-codes` → QR plus the typed code
   and a 5-minute countdown; device list with last seen and **Remove**.
   Confirmation is inline (two-step button), not `confirm()`.
5. **System**: today's health dashboard, plus jobs by step/state, connector lag,
   extraction cost.

### Auth in the browser

Admin token in `sessionStorage` (cleared when the tab closes) instead of the current
`localStorage` in `connection.ts`. Note the change and why in the README.

### Seeded demo

`scripts/seed-demo.ts`: generates ~40 synthetic PDFs (use `assemble` from
`@sheaf/pdf` over generated images, or ship 10 synthetic receipts) with plausible
text, PUTs them and their text to a local server, so screenshots never show real
documents.

**Acceptance.** All five pages work against the seeded server; `pnpm bundle:web`
passes in CI.

---

## 4.3 Observability (≈2 h)

### Files

- `services/ingest/src/metrics.ts`: a minimal registry (zero dependencies):
  `counter(name, help, labelNames)`, `gauge`, `histogram(buckets)`, and
  `render(): string` in Prometheus text format 0.0.4. About 100 lines, unit-tested
  against expected text output.
- `services/ingest/src/log.ts`: `log.info(msg, fields)` → one JSON line
  `{ts, level, msg, ...fields}`. Replace `console.log` / `console.error` in
  `main.ts` and the tick loops.
- `server.ts`: per request, record `sheaf_http_requests_total{route,method,status}` and
  `sheaf_http_request_duration_seconds{route}`. **`route` must be the template**
  (`/v1/documents/:sha`, `/v1/archive/:id`), never the raw path, or every sha256
  becomes its own time series and Prometheus falls over. Write `routeTemplate(path)`
  as a pure function and test it.
- Gauges refreshed on scrape: `sheaf_documents`, `sheaf_jobs{step,state}`,
  `sheaf_deliveries{connector,state}`, `sheaf_connector_oldest_pending_seconds{connector}`.
- `GET /metrics`: admin token **or** a request from loopback/the compose network
  (so Prometheus can scrape without a token in a file, if you prefer).

### Compose and dashboard

- `compose.observability.yml`: `prometheus` (scrape `ingest:8787/metrics` every 15s,
  bearer token from a file via `authorization.credentials_file`) and `grafana`
  (anonymous viewer on, provisioning from `ops/grafana/`).
- `ops/grafana/dashboards/sheaf.json`: request rate by status, p95 latency, job queue
  depth by step, connector lag, extraction cost per hour. Build it in the UI, then
  export the JSON into the repo.

**Acceptance.** Screenshot of the dashboard during the 4.4 load run, committed to
`docs/media/`.

---

## 4.4 Load and chaos script (≈1.5 h)

`scripts/demo-load.ts`, run with `node --experimental-strip-types`:

1. Start the server as a child process on a temp data dir with a known token.
2. Create N=20 virtual devices (pair each via the API, which also exercises 4.1),
   each with M=25 synthetic documents.
3. Each device uploads through a **flaky fetch wrapper**: 10% connection refused,
   10% "response lost" (await the real request, then throw anyway), random 0–500 ms
   delay. Devices retry with `backoffMs`, exactly like the phone, using `HEAD` to
   check before re-sending after a lost response.
4. Meanwhile, `kill -9` the server at three random moments and restart it.
5. When every device reports done: check `GET /v1/documents` count equals N×M,
   every sha answers `HEAD 200`, the objects directory holds exactly N×M files,
   and job states are all terminal.
6. Print a summary table: uploads attempted, lost responses, server kills,
   documents stored, **lost: 0, duplicated: 0**, wall time. Exit non-zero
   otherwise.

Record it with `vhs` or asciinema for the README.

**Acceptance.** Runs green three times in a row with different seeds (print the
seed; accept `--seed` to replay one).

---

## 4.5 The write-up (≈2 h)

1. **README** final pass: GIF, three numbers (now including eval accuracy and chaos
   results), architecture diagram, "For reviewers" link.
2. **`docs/FOR-REVIEWERS.md`**: the role table from
   [04-portfolio-strategy.md](../04-portfolio-strategy.md), with links to the exact
   files.
3. **Blog post** following the outline in 04-portfolio-strategy.md. Use real
   defects from `field-notes.md`. They are the most interesting part.
4. GitHub: About text, topics, website link, pin the repo, a `v1.0.0` release with
   the video and screenshots.
5. Share: LinkedIn post with the GIF; r/selfhosted (lead with standalone and
   privacy, not the engineering); Show HN once a stranger has installed it
   successfully from the README.

---

## End of week 4

- ADR 0008 → accepted; every roadmap ADR status is now honest.
- `CHANGELOG.md` → `1.0.0`; tag `v1.0.0`.
- Retrospective: add a short "What the plan got wrong" section at the bottom of
  `docs/roadmap/03-four-week-plan.md`. Planning that admits its misses reads well.
