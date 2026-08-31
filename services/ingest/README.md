# @sheaf/ingest

The server Sheaf uploads to. Content-addressed, idempotent, and no runtime
dependencies — `node:http`, `node:sqlite`, `node:fs` and nothing else.

## Running it

```bash
export SHEAF_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
pnpm --filter @sheaf/ingest start
```

Or in Docker, which reads the token from a gitignored `.env` at the repo root:

```bash
echo "SHEAF_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env
docker compose up -d
```

## Reaching it from a phone

The server listens on every interface, so a phone on the same network can reach it
at your machine's LAN address — `http://192.168.x.x:8787`. `localhost` only works
from the machine itself and from an iOS simulator, which shares its host's network.

iOS will not talk to a plain-HTTP address on a local network without two things in
`Info.plist`, both of which the app sets: `NSAllowsLocalNetworking`, and
`NSLocalNetworkUsageDescription` so the permission prompt can explain itself. A
missing prompt fails silently, and looks exactly like a server that is down.

| Variable               | Default         |                                                                                                     |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `SHEAF_TOKEN`          | —               | Required. At least 16 characters; the server refuses to start without it.                           |
| `SHEAF_DATA_DIR`       | `./.sheaf-data` | Documents and the metadata database.                                                                |
| `PORT`                 | `8787`          |                                                                                                     |
| `SHEAF_RETENTION_DAYS` | unset           | Free a document's bytes this many days after Paperless confirms it. Unset keeps every copy forever. |

There is no default token on purpose. A server holding someone's documents should
not come up guessable, so it would rather not come up at all.

## Retention

Storing is unconditional; forwarding is opt-in; freeing the bytes afterwards is a
third, separate decision, off unless `SHEAF_RETENTION_DAYS` is set. This server has
no owner watching an outbox the way a phone's owner watches theirs, so the default
everywhere else in this project — keep the extra copy — holds here too until
someone explicitly decides Paperless is trustworthy enough to be the only one.

Once a document has been in `forward.state: 'done'` for that many days, its bytes
are deleted and `GET` on it answers `410` instead of `200` — the row, and everything
Paperless already made searchable, are untouched. `404` still means "never
existed"; `410` means "existed, and Paperless has it."

## Suggestions

Storing a document and forwarding it are decisions this server makes on its own.
Whether Paperless has anything to say about it is not: once forwarding lands a
document and names it, the server asks Paperless's classifier what it thinks --
correspondent, type, tags, date -- and caches the answer, so the phone that
captured it can show a suggestion without ever talking to Paperless itself.

`GET .../suggestions` answers `{ "suggestions": null }` until that first answer
lands, and `{ "suggestions": {...} }` -- possibly `{}` -- once it has. The
difference matters to a client that only asks once and stops: `null` means ask
again later, an object means stop asking, and there is no way to tell "nothing to
suggest yet" from "nothing to suggest, ever" in what Paperless returns, so this
does not pretend to.

## Reconciliation health

Crash recovery finds a document it lost track of by asking Paperless to filter on
`original_filename__istartswith` -- see [ADR 0004](../../docs/adr/0004-reconcile-by-filename.md).
DRF ignores a filter parameter it does not recognise rather than rejecting it, so a
server where that filter has stopped working answers every query as if it were
unfiltered, and reconciliation degrades to silently re-uploading duplicates that
Paperless then refuses. Nothing breaks, but it is not free, and not something
anyone would otherwise notice.

Once at startup, the server probes for this the same way `probeReconciliation()`
always could: search for a filename that cannot exist, and see whether Paperless
comes back empty. The result rides along in `/v1/health`'s `forwarding` object
once it lands:

```json
"forwarding": {
  "target": "paperless.example.com",
  "counts": { "done": 41 },
  "reconciliation": { "filterSupported": true, "conclusive": true, "detail": "..." },
  "retention": { "days": 30, "released": 12 }
}
```

`retention` is absent the same way `reconciliation` can be -- here, whenever `SHEAF_RETENTION_DAYS` is unset. `released` is a live count, not a setting: how many documents have actually had their bytes freed so far, which is the number worth watching if disk usage is the reason retention was turned on at all.

Absent from the response until the probe answers, and diagnostic only --
correctness never depends on what it finds.

## Browsing the archive

Storing and forwarding are decisions this server makes and remembers; browsing is
not. `GET /v1/archive` searches everything Paperless holds -- not just what this
server captured -- by asking Paperless live and forgetting the answer
immediately. There is no local mirror to keep fresh, so there is nothing that can
go stale: this route is only ever as current as Paperless itself is, right now.

Requires `PAPERLESS_URL` to be set, for the obvious reason that there is nothing
to browse otherwise -- every route under `/v1/archive` answers `503
archive_disabled` rather than `404` when it is not, so a client can tell "this
server has no archive to browse" from "you mistyped the URL".

Ids here are Paperless's own, not the sha256 this server uses for what it stores
itself: a document already in your archive before Sheaf existed has no sha256 to
be found by. `PATCH` takes correspondent, document type and tags as ids too, for
the same reason -- they are foreign keys in Paperless, not free text this server
would otherwise have to reconcile.

## The protocol

```
PUT    /v1/documents/{sha256}                the bytes, raw
HEAD   /v1/documents/{sha256}                do you have this?
GET    /v1/documents/{sha256}                give it back, or 410 if retention already freed it
PATCH  /v1/documents/{sha256}                title, correspondent, type, tags
GET    /v1/documents/{sha256}/suggestions    what the classifier makes of it, once it has answered
GET    /v1/documents                         what do you have
GET    /v1/archive?query=&page=&...          search everything Paperless holds, live
GET    /v1/archive/vocabulary                correspondents, document types, tags -- with names
GET    /v1/archive/{id}                      one archive document, by Paperless's own id
GET    /v1/archive/{id}/thumbnail            its thumbnail, whatever format Paperless made it in
PATCH  /v1/archive/{id}                      title, correspondent, type, tags -- by id, not text
GET    /v1/health                            and are you well
```

A document lives at the address of its own content. Three consequences, and they
are the reason this service exists at all:

**Retrying is free.** `PUT` to the same URL with the same bytes cannot create a
second document — `201` the first time, `200` after that. Both are success. A client
that lost a response simply sends again and gets told it already landed. No
idempotency key, and no reading a duplicate-detection message whose wording changes
between server versions.

**Recovery is a question, not a search.** After a crash the client asks `HEAD` and
gets a status code. Previously this had to be a filtered query, and the filter could
be silently ignored by a server that did not support it — which would have answered
"yes, I have it" about documents it had never seen.

**Corruption is caught at the door.** The address is a claim about the content, so
the server verifies `sha256(body)` against it and answers `409` on a mismatch. A
truncated upload is refused rather than stored under an identity it does not have.

Path traversal is not defended against; it is unrepresentable. Identifiers must
match `^[0-9a-f]{64}$`, so `..` is not a document id that got rejected — it is not a
document id.

## Tests

`handle()` is a pure function of a parsed request, so every route is tested without
a socket. `server.test.ts` covers only what needs a real connection: refusing an
oversized upload while it is still arriving, and `HEAD` carrying no body.
