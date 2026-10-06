# Exactly-once document capture on a phone, with no idempotency key

_How to promise that a photograph of a receipt will never be lost or duplicated —
and what that promise cost, which bugs it hid, and why the default AI in this
project is a regular expression._

---

## The failure nobody handles

Photograph a receipt. Upload it. The phone is in a tunnel, the server stores the
document, and the response is lost on the way back.

Now you are in the worst possible position. You know the bytes are on a server you
cannot see. You can retry, and you might create a second copy. Or you can give up,
and show the user a red error next to a document that is, in fact, safely stored.

Most sync systems handle the _first_ failure — the request that never arrives. Very
few handle the second: the request that arrived, did its work, and whose answer
vanished. It is the failure that makes "we never lose your documents" an unfalsifiable
claim, because the user has no way to check.

Sheaf is a document capture app. That failure is the product.

## Identity as a hash

The fix is to make the document's identity a function of its content:

```ts
const sha256 = await sha256(pdfBytes);
await fetch(`${base}/v1/documents/${sha256}`, { method: 'PUT', body: pdfBytes });
```

The address of the document _is_ the hash of the document. This buys three things
for free:

1. **Resending is a no-op.** If the bytes are already there, storing them again
   changes nothing. No idempotency key, no dedup window, no server-side bookkeeping.
2. **Uncertainty is resolvable.** After a lost reply, ask `HEAD /v1/documents/<sha>`
   before resending. The hash is the question, and the answer is unambiguous.
3. **Two phones photographing the same page converge**, because identical pages
   produce identical PDF bytes and therefore one identity.

Point 3 is worth a caveat, and we were careful about it: identical bytes means
_identical capture_. Two photographs of the same receipt are different bytes, so
content addressing does not deduplicate them. That needs perceptual hashing, and
`packages/pdf` does it — but it flags the capture as _familiar_ rather than silently
merging it, because two photographs that hash the same really might be two different
pages from a stack of identical paper.

## Status as a derived value

The second decision is about state. The phone does not store a `status` column. It
stores an append-only log of events, and the status is whatever you get from
replaying them:

```ts
const state: DocState = events.reduce(reduce, initial);
// state.status is a function of history, not a thing anyone wrote down
```

This is unglamorous and it pays for itself under pressure. An append-only log can
only be truncated at a record boundary by a crash, so replay always produces a
valid state. Crash recovery is not recovery _logic_ — it is a property of the data
structure. And illegal transitions stop being bugs you must test for, because they
cannot be represented: there is no code that writes `SYNCED` into a row.

The cost is honest: replay is O(history), and a naive implementation of the sync loop
replayed _every_ document's log on every tick. At 1,000 documents that was 107 ms of
blocking work every three seconds, on the thread that draws the UI. Fixed with a
cache — 0.3 ms. I mention it because the elegance of "just replay everything" is
exactly what hides that cost until someone has 1,000 documents.

The other thing the log buys is free: **the paper trail**. Because history is a thing
we already have, "show me what happened to this document" is one query, and the
output is the real event history rather than a log line someone wrote by hand:

```
10:32:04  Captured (4 pages)
10:32:05  Upload attempt 1 → server unreachable
10:40:51  Network returned (Wi-Fi)
10:40:52  Upload attempt 3 → accepted
10:41:09  Text sent from the phone
10:41:12  Details read by heuristic-2
```

## Testing a promise, not a function

Unit tests say the state machine transitions correctly given the events you thought
of. That is not the same as saying the promise holds on a bad network.

So `packages/sim` runs the real engine, against a real store, over a virtual clock
and a seeded random stream, and injects the failures: dropped requests, replies lost
_after_ the server stored the document, 5xx, 401, rate limits, offline windows, and
process kills — including kills landing between logging an upload attempt and logging
its outcome, which is the window where a naive implementation loses track of itself.

The current run: 300 hostile schedules over 1,500 documents and **3,644 process
kills**. The engine issued 2,003 uploads, stored exactly 1,500 documents, correctly
read 490 duplicate rejections as success, and recovered 255 interrupted uploads with
a hash lookup instead of a re-upload. Nothing lost, nothing duplicated.

Being able to _replay_ a failing seed is what makes this a tool rather than a ritual.
When something breaks, you get the seed number and the whole run reproduces.

### What the simulation found that tests did not

The most instructive bugs in this project came from probes written to be hard rather
than to pass.

**The test fixture was making the code untestable.** The simulator's fake Paperless
consumed an upload task only when polled — which is realistic, and meant the
"duplicate rejection" branch was never reachable. The suite passed, comprehensively,
over a code path it never executed. The only reason I found it was that I wrote a
mutation (delete the duplicate-handling branch) and the suite still passed. A test
suite that cannot fail is worse than no suite.

**A hand-written SHA-256 had a padding bug.** All three published test vectors
passed. Lengths 55, 119 and 183 did not: whenever `length + 9` was a multiple of 64,
an extra block was emitted. The cross-check against `node:crypto` at every length
from 0 to 200 found it in about a second of runtime. This one is a good argument for
not hand-rolling cryptography — but it is a better argument for testing _the
boundaries_, since the published vectors all sat comfortably inside a block.

**An error that should not have been retried, was retried forever.** When the server
answered 404 for suggestions, the app re-asked on every tick, per synced document. In
200 ticks that was 198 requests; at 50 documents it would have been roughly 17
requests per second against somebody's home server. Not a crash — a slow, polite,
sustained denial of service, from a client that was trying to be helpful.

**Reconciliation would have lied.** The plan was to confirm un-uploaded documents by
asking the server for a filtered list. DRF silently ignores that filter parameter. A
server that does not understand the filter returns _everything_, so the reconciliation
would have concluded that everything was safely stored — including the documents that
had never been uploaded. The fix was not to "handle" the response but to _detect_ that
the server ignored the filter, and refuse to conclude anything when it did.

## Testing the belief, not the code

The simulator tests our protocol. It cannot test our assumption about someone else's.

Paperless-ngx answers `POST /api/documents/post_document/` with a Celery task id, and
the real outcome arrives asynchronously. An entire exactly-once design rests on
reading that async result correctly. Mocks encode what we _believe_ the API does.

So there is a contract suite ([`packages/paperless/test/contract`](../../packages/paperless/test/contract))
that starts a real Paperless-ngx in Docker, uploads a real document, waits for a real
consumption, and searches for it. It runs weekly in CI against both a pinned version
and `latest`, where a failure on `latest` is the signal to re-pin.

It has earned its keep. Two things it found that no mock would have:

- The stored document's id arrives as `related_document_ids`, a **list**, not the
  singular field the code was reading. It happened to work on the first document and
  break on the second.
- Searching with `text=` **400s on a colon in the query**, but only once the query
  actually matches a document. So `total: 12.50` fails only for some searches — the
  worst possible shape of bug. This one is documented rather than worked around,
  because no client-side query syntax avoids it.

It also gave a real answer to a real risk. When Paperless-ngx 3.0 landed (July 2026)
it redesigned the tasks API and dropped API versions below 9 — a plausible break for
`tasks.ts`. The suite passed 11/11 against 3.2.1 unchanged. Some of that was luck; the
weekly `latest` run is what turns luck into a habit.

## Going standalone

The original design was a companion to Paperless-ngx: the phone captures, Paperless
stores, OCRs, searches and suggests. That is a fine product, but it has two problems.
It is not a product on its own — without Paperless you get a box of unsearchable
PDFs. And the research turned up something that changed the plan:

> Paperless-ngx 3.0 shipped its own AI suggestions, RAG chat and embeddings.
> "Classify later with the model's help" stopped being our differentiator and became
> their feature.

Competing with an established DMS on DMS features is a losing move. So
[ADR 0007](../../docs/adr/0007-sheaf-is-the-system-of-record.md) inverted the
dependency:

- **Sheaf's server owns the record.** It stores documents, keeps their text, indexes
  them, and reads their details.
- **Paperless became a connector** — one destination among several, configured
  optionally. `docker compose up` now starts Sheaf alone.

The engineering consequence is that exactly-once had to be solved again, one level
up. Delivery was idempotent by content hash; now the _work_ after storage — OCR,
text extraction, forwarding — has to be idempotent too, because it is spread across
process restarts:

```sql
CREATE TABLE jobs (
  sha256       TEXT NOT NULL,
  step         TEXT NOT NULL,
  step_version INTEGER NOT NULL,   -- bump to re-run this step for every document
  state        TEXT NOT NULL,
  next_at      INTEGER,
  PRIMARY KEY (sha256, step, step_version)
);
```

Each step runs at most once per document per version, in dependency order, and
resumes after a crash because `run()` is idempotent — which is why recovering rows
stuck in `running` is safe, and why that safety deserves a comment in the code and a
test rather than a belief. Convergence under 200 seeded crash schedules is a test.

## Why the default AI is a regular expression

The server reads each document's title, date, sender, type and total. There are three
implementations behind one port: a **heuristic** (rules), **Claude**, and **Ollama**.
Choosing Claude sends document text to Anthropic, so it is opt-in, and the default is
whatever sends nothing anywhere.

The interesting result is that the regex extractor is genuinely competitive. Measured
on 50 held-out receipts from SROIE (ICDAR 2019), normalised and scored field by field:

| Extractor | date  | total | correspondent | Cost/doc | p50    |
| --------- | ----- | ----- | ------------- | -------- | ------ |
| heuristic | 98.0% | 84.0% | 96.0%         | $0.00000 | 0.1 ms |

84% on the hardest field — the total — for free, offline, in a tenth of a
millisecond. That number came from an eval harness with a record/replay cache, so the
CI gate costs nothing and the same harness compares providers honestly.

It also came from being wrong first. The first run scored **52%** on totals, and the
fixes were not clever: a GST summary table whose own "TOTAL" is the tax, amounts
printed two lines below their label, "TOTAL INCL. GST" rejected for mentioning GST,
and cash tendered mistaken for the bill. Each became a general rule. Test sample 52%
→ 84%. Every other field unchanged.

Two habits did the work here. **Tune on a dev set, never on the test set** — there
are 586 other labelled receipts, and tuning on the 50 you report is just a slower way
of lying. And **make accuracy a CI gate**, so "did the AI get better or just
different?" has an answer that is not your memory.

Meanwhile the harness caught that a date regex read `Oct 2026` as 20 October '26,
because nothing required a separator between day and year.

## What running it for real taught me

The last and most productive lesson: the bugs that hurt were the ones no test could
have found, because they were bugs in _my assumptions about the world_.

- **The plan said to use SQLite's `rowid` as an archive id.** `documents` has a text
  primary key, so SQLite may renumber rowids under `VACUUM` — and the phone caches
  those ids. Ids now live in a table whose `INTEGER PRIMARY KEY` never moves, and a
  test vacuums and checks.
- **The OCR container's Dockerfile would not have built.** The base image already runs
  as uid 1000, so my `adduser` failed. Also: the repo's page fixtures are 480×640,
  far too small for Tesseract to read anything — so my first "OCR works" test was
  measuring nothing.
- **A rate limiter counted successes.** Pairing attempts were limited per address, and
  because the limiter counted every _successful_ pairing, the eleventh phone on one
  household's NAT was refused for a minute. The chaos run hung on it. It now counts
  failures.
- **An undeclared package dependency** made the server crash on start outside Docker.
  Every test passed, because Vitest resolves workspace packages through aliases and
  the image links them by hand. Only the server's own `package.json` was wrong. CI now
  starts the server the way a developer does, outside Docker, precisely to catch the
  class of bug where the test environment is more forgiving than production.
- **A money formatter rendered `NaN` as "€NaN"** — found by a test I wrote while
  writing this post. Small, but it is the kind of thing that reaches a user deciding
  what to pay.

The pattern is consistent: **every one of these was found by doing the thing, not by
reasoning about the thing.** The chaos script found the rate limiter. The real
container found the Dockerfile. Starting the server the ordinary way found the
dependency. Running the app in a browser found four interface problems in an hour.

The tests were necessary. They were not sufficient, and no amount of unit testing
would have made them sufficient.

## What is not done

The app has never run on a physical phone. It builds, boots in the iOS Simulator,
and passes typecheck, lint and bundling; the camera, permission prompts and the
end-to-end flows are untested on hardware. Android has never been built. The
acceptance triage swipe is unimplemented. Search is BM25, not semantic.

I would rather say that plainly than let a green tick imply more than it does. The
durability engine underneath is the part I have actually tested, and it is tested
hard: 728 tests, 3,644 simulated process kills, a 500-document chaos run through
three real `SIGKILL`s, and every count checked afterwards.

---

**Repository:** [Sheaf](https://github.com/) — see
[`docs/FOR-REVIEWERS.md`](../../docs/FOR-REVIEWERS.md) for a map from your area of
interest to the exact files, and the [roadmap](../../docs/roadmap/README.md) for how
the plan was made and where it was wrong.
