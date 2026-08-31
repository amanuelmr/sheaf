# @sheaf/admin

A window onto what the ingest server is doing, in place of reading `/v1/health`
as raw JSON. Forwarding, reconciliation, retention — everything that server
already tracks and answers with, given a page that can ask it more than once a
minute and draw the answer instead of printing it.

## Running it

```bash
pnpm --filter @sheaf/admin dev
```

Opens at `http://localhost:5173`. On first load it asks for the ingest server's
URL and its `SHEAF_TOKEN` — the same token used everywhere else. Both are kept
in this browser's `localStorage` and nowhere else; see `src/connection.ts` for
why that is an honest trade-off rather than a real keystore.

## What it does, and does not, do

Polls `GET /v1/health` every five seconds and renders it: document count,
forwarding target and per-state counts, the reconciliation probe, retention's
days and how many documents it has actually released. A poll that fails leaves
the last good reading on screen rather than blanking it out — one dropped
request over a flaky connection should not read as "the server has stopped
working."

Nothing here browses or edits documents — that is `/library` in the mobile app,
talking to `/v1/archive`. This page only ever reads `/v1/health`, and only ever
reads it; there is no write path, on purpose. It answers "is my server doing
what I think it's doing," not "let me manage my documents from a browser."

## CORS

The ingest server answers every request, from any origin, with
`Access-Control-Allow-Origin: *` — see `services/ingest/src/server.ts`. That is
deliberate, not an oversight: the token is what actually gates access, there
are no cookies for a stray origin to ride along on, and restricting the origin
would protect nothing while breaking the one browser client this protocol has.
