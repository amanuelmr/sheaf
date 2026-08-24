# @sheaf/ingest

The server Sheaf uploads to. Content-addressed, idempotent, and no runtime
dependencies — `node:http`, `node:sqlite`, `node:fs` and nothing else.

## Running it

```bash
export SHEAF_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
pnpm --filter @sheaf/ingest start
```

| Variable         | Default         |                                                                           |
| ---------------- | --------------- | ------------------------------------------------------------------------- |
| `SHEAF_TOKEN`    | —               | Required. At least 16 characters; the server refuses to start without it. |
| `SHEAF_DATA_DIR` | `./.sheaf-data` | Documents and the metadata database.                                      |
| `PORT`           | `8787`          |                                                                           |

There is no default token on purpose. A server holding someone's documents should
not come up guessable, so it would rather not come up at all.

## The protocol

```
PUT    /v1/documents/{sha256}    the bytes, raw
HEAD   /v1/documents/{sha256}    do you have this?
GET    /v1/documents/{sha256}    give it back
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
