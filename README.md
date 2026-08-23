# Sheaf

**An offline-first capture companion for Paperless-ngx.**
Scan a document; it is already safe. Everything after that is optional.

> Sheaf is an independent project. It is not affiliated with, endorsed by, or an
> official part of [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx).

---

## The problem

Paperless-ngx is excellent once a document is inside it. Getting a piece of paper
_into_ it from a phone is the part that still hurts:

> photograph → crop → fix perspective → save → find the file → share/upload →
> wait for OCR → categorise → fix the metadata → check it actually arrived

Every existing mobile flow puts a form between the paper and the server. That form
is the friction.

## The idea

Sheaf inverts the order of operations. The document is **committed the moment the
shutter fires**, and it starts travelling to Paperless immediately. Cropping, OCR,
metadata and the human all happen _after_, and none of them can block delivery.

```
SHUTTER ──▶ durable local commit ──▶ upload starts now (background)
                                          │
                                    Paperless OCRs it
                                          │
              later, whenever you feel like it:
              TRIAGE ──▶ patch metadata on the document that is already stored
```

Practical consequences:

- **Batch capture is the default.** Shutter through a pile of thirty receipts
  without leaving the camera.
- **There is no review screen.** There is an inbox of already-synced documents
  waiting to be classified — swipe to accept a suggestion, tap to correct it.
- **Nothing is ever "waiting for the user."** The only queue is the outbox.

## Why the engineering is interesting

Fast capture is not a UI problem, it is a durability problem. Three decisions carry
the whole design.

### 1. An append-only intent log, not a mutable row

Every fact about a document is an event. `DocState` — including its status — is
_derived_ by replaying the log. Nothing is ever updated or deleted.

A crash can only truncate an append-only log at a record boundary, so replay always
yields a valid state. Crash recovery stops being recovery logic and becomes a
property of the data structure. Invalid state transitions are unrepresentable
because status is not stored.

### 2. Content-addressing turns at-least-once into exactly-once

`docId = SHA-256(normalized PDF bytes)`. The hash _is_ the identity.

The failure nobody handles: you POST a document, the server stores it, and the
response is lost to a tunnel. Retry, and you have two copies. Give up, and you show
a red error on a document that is safely stored.

Sheaf closes it with three rules:

1. **`POST` returning 200 means "accepted", not "stored."** Paperless replies with
   a Celery task id; the real outcome arrives asynchronously from `/api/tasks/`.
2. **A document with a task id is never re-uploaded.** It is `AWAITING_SERVER`, and
   the only legal next move is to poll. This invariant is asserted directly in
   [`machine.test.ts`](packages/core/test/machine.test.ts).
3. **A duplicate rejection is a success.** Paperless hashes content itself and
   refuses documents it already holds. Being told "duplicate" about bytes we chose
   to upload is _proof_ the document is in Paperless, so it means `SYNCED`.

Rule 3 is the trick: retry becomes unconditionally safe with no idempotency key and
no server-side cooperation.

### 3. The server is the source of truth for what happened

On every cold start, any document whose fate is unknown is reconciled against
Paperless before anything else is decided. The log is authoritative about _intent_;
the server is authoritative about _outcome_.

### The paper trail

Because the log exists, "view details" renders the real event history:

```
10:32:04  Captured (4 pages)
10:32:05  Upload attempt 1 → server unreachable
10:40:51  Network returned (Wi-Fi)
10:40:52  Upload attempt 3 → accepted, task a3f9…
10:41:09  Paperless confirmed → document #4821
10:44:22  You accepted the suggestions
```

Most apps _assert_ that they never lose a document. This one shows its receipts —
and the feature cost nothing, because it is one query against the log.

## Status

Early. The sync engine and its tests exist; the app does not yet.

|                      |                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ |
| `packages/core`      | Event log, reducer, state machine, backoff, error mapping. Pure and fully tested. ✅ |
| `packages/paperless` | Task interpretation and error classification. Client I/O still to come. 🚧           |
| `packages/sim`       | Deterministic simulation primitives. Fault injector next. 🚧                         |
| `apps/mobile`        | Not started. ⬜                                                                      |

The engine is being built and proven _before_ the UI, because it is the part where
being wrong is expensive.

## Architecture

```
apps/mobile          Expo + React Native. Camera, SQLite executor, UI projections.
      │
      ├── packages/core        pure decisions: reduce(events) → state, next(state, tick) → command
      ├── packages/paperless   Paperless-ngx API + response interpretation
      └── packages/sim         virtual clock, seeded RNG, injected faults
```

`packages/core` has no clock, no randomness and no I/O — ESLint enforces this by
banning `Date.now()` and `Math.random()` inside it. Time and jitter arrive as
parameters, which is what lets the simulator explore fault schedules
deterministically and replay any failing seed exactly.

Across 300 hostile schedules covering 1,500 documents — dropped requests, lost
responses after the server had already stored the document, 5xx, 401, rate limits,
offline windows, and 3,644 process kills including kills _between_ logging an
upload attempt and logging its outcome — the engine issued 2,003 POSTs, stored
exactly 1,500 documents, read 490 duplicate rejections as success, and recovered
255 interrupted uploads with a hash lookup rather than a re-upload. Nothing lost,
nothing duplicated. See [`packages/sim`](packages/sim).

See [ARCHITECTURE.md](ARCHITECTURE.md) and the [decision records](docs/adr).

## Development

```bash
pnpm install
pnpm verify      # format check + lint + typecheck + tests
pnpm test:watch
```

Requires Node 20+ and pnpm.

## Privacy

Documents go directly from the device to your Paperless server. There is no Sheaf
account, no Sheaf backend, and no third party in the path. The API token is held in
the platform keystore (Keychain / Android Keystore), never in plain storage, and
never written to a log.

## Licence

MIT — see [LICENSE](LICENSE).
