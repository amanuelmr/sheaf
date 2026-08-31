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

## The protocol

```
PUT    /v1/documents/{sha256}    the bytes, raw
HEAD   /v1/documents/{sha256}    do you have this?
GET    /v1/documents/{sha256}    give it back, or 410 if retention already freed it
PATCH  /v1/documents/{sha256}    title, correspondent, type, tags
GET    /v1/documents             what do you have
GET    /v1/health                and are you well
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
