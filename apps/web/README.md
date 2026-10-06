# @sheaf/web

A browser client for the Sheaf server: search your documents, read one with its
fields and its history, review what the extractor guessed, pair and remove phones,
and watch the server's own health.

Five pages, hash-routed (`#/search`, `#/doc/<sha256>`, `#/inbox`, `#/devices`,
`#/system`). Five pages do not need a router library.

## Running it

```bash
pnpm --filter @sheaf/web dev
```

Opens at `http://localhost:5173`. On first load it asks for the server's URL and
its admin `SHEAF_TOKEN`.

The **URL** is kept in `localStorage` so the app greets you next time; the
**token** is kept in `sessionStorage` only, so closing the tab forgets it. That is
a deliberate trade-off and not a real keystore: a token in browser storage is
readable by any script on the origin, which is why it is scoped to one tab
session rather than kept around for weeks. See `src/connection.ts`.

## The pages

| Route                  | What it does                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `#/search`             | The home page. Debounced search over the server's own catalog (FTS5, BM25), plus the most recent documents. Snippets are marked. |
| `#/doc/<sha>`          | The PDF in an `<iframe>`, every field with **where it came from** (`machine · 0.85` or `you`), editable, and the paper trail.    |
| `#/inbox`              | Documents whose machine fields nobody has accepted or corrected. Keyboard driven: `j`/`k` to move, `a` to accept, `e` to edit.   |
| `#/devices` ("Phones") | Pair a phone by QR code (or a typed code, with a live countdown), list paired phones with their last-seen, and remove one.       |
| `#/system`             | The server's own health: documents, jobs by step and state, deliveries per connector, retention.                                 |

Provenance on each field is the point of the document page: it is the difference
between "the model said €26.07" and "€26.07 came out of `30.00 − 3.93` on the
receipt, and you never touched it."

## Notes

- **Search snippets contain document text.** They are rendered as React text
  nodes split on the server's `«»` markers — never `dangerouslySetInnerHTML`.
- **Routing rejects lookalikes.** `parse()` only accepts a 64-character lowercase
  hex document id, so a crafted hash cannot navigate anywhere unexpected.
- **Removing a phone asks twice** — an inline second click, not `confirm()`.

## CORS

The ingest server answers every request, from any origin, with
`Access-Control-Allow-Origin: *` — see `services/ingest/src/server.ts`. That is
deliberate, not an oversight: the token is what actually gates access, there are
no cookies for a stray origin to ride along on, and restricting the origin would
protect nothing while breaking the one browser client this protocol has. Admin
routes (`/v1/devices`, `/v1/pairing-codes`, `/metrics`) additionally require the
admin token, so a leaked device token cannot reach them.
