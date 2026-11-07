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

| Variable                         | Default                                        |                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHEAF_TOKEN`                    | —                                              | Required. At least 16 characters; the server refuses to start without it.                                                                                                                                                                                                                            |
| `SHEAF_DATA_DIR`                 | `./.sheaf-data`                                | Documents and the metadata database.                                                                                                                                                                                                                                                                 |
| `PORT`                           | `8787`                                         |                                                                                                                                                                                                                                                                                                      |
| `SHEAF_RETENTION_DAYS`           | unset                                          | Free a document's bytes this many days after Paperless confirms it. Unset keeps every copy forever.                                                                                                                                                                                                  |
| `SHEAF_TRASH_DAYS`               | `30`                                           | Days a deleted document waits in the trash before it is deleted for good. At least 1.                                                                                                                                                                                                                |
| `SHEAF_FILENAME_FORMAT`          | `{{created_year}}/{{correspondent}}/{{title}}` | How exported files are named; see "Export and import".                                                                                                                                                                                                                                               |
| `SHEAF_CONSUME_DIR`              | unset                                          | A folder to take PDFs in from. Each is stored once it stops growing, then removed; anything else moves to `failed/` inside it.                                                                                                                                                                       |
| `SHEAF_CONSUME_SUBDIRS_AS_TAGS`  | `false`                                        | `true`: the subfolders a file was dropped in become tags on it.                                                                                                                                                                                                                                      |
| `SHEAF_CONSUME_DOUBLE_SIDED_DIR` | `double-sided`                                 | A subfolder for one-sided feeders: drop the fronts, then the backs as they come out (last page first), and they are stored as one document in page order. Fronts left more than 30 minutes start over.                                                                                               |
| `SHEAF_MAIL_HOST`                | unset                                          | An IMAP server to take PDF attachments from, over TLS. Needs `SHEAF_MAIL_USER` and `SHEAF_MAIL_PASSWORD`.                                                                                                                                                                                            |
| `SHEAF_MAIL_PORT`                | `993`                                          |                                                                                                                                                                                                                                                                                                      |
| `SHEAF_MAIL_FOLDER`              | `INBOX`                                        | Only unread mail in it is read.                                                                                                                                                                                                                                                                      |
| `SHEAF_MAIL_AFTER`               | `seen`                                         | `seen` marks mail read once its PDFs are stored; `delete` deletes it. Mail with no PDF is marked read either way.                                                                                                                                                                                    |
| `SHEAF_MAIL_TAG`                 | unset                                          | A tag for every document that came by mail.                                                                                                                                                                                                                                                          |
| `SHEAF_MAIL_INTERVAL_MINUTES`    | `5`                                            | How often to look.                                                                                                                                                                                                                                                                                   |
| `SHEAF_POST_CONSUME_SCRIPT`      | unset                                          | An executable run once for each new document after it is filed, with `DOCUMENT_ID`, `DOCUMENT_FILE`, `DOCUMENT_TITLE`, `DOCUMENT_CORRESPONDENT`, `DOCUMENT_TYPE`, `DOCUMENT_TAGS`, `DOCUMENT_CREATED`, `DOCUMENT_ASN` and `DOCUMENT_RECEIVED` in its environment. Run directly, not through a shell. |
| `SHEAF_SMTP_HOST`                | unset                                          | A mail server for workflows that send email. Needs `SHEAF_SMTP_FROM`; `SHEAF_SMTP_USER` and `SHEAF_SMTP_PASSWORD` when it asks for a login.                                                                                                                                                          |
| `SHEAF_SMTP_SECURITY`            | `starttls`                                     | `starttls` (port 587 by default) or `tls` (465). Mail is never sent unencrypted.                                                                                                                                                                                                                     |
| `SHEAF_SMTP_PORT`                | `587` / `465`                                  |                                                                                                                                                                                                                                                                                                      |
| `SHEAF_SMTP_FROM`                | —                                              | The address mail comes from.                                                                                                                                                                                                                                                                         |
| `SHEAF_OIDC_ISSUER`              | unset                                          | An OpenID Connect provider (Keycloak, Authentik, Google…) for single sign-on. Needs `SHEAF_OIDC_CLIENT_ID`, `SHEAF_OIDC_CLIENT_SECRET`, `SHEAF_OIDC_REDIRECT_URI` (`<this server>/v1/sso/callback`, registered with the provider) and `SHEAF_WEB_URL`.                                               |
| `SHEAF_OIDC_DEFAULT_ROLE`        | `viewer`                                       | The role someone new gets on first sign-in; `none` lets in only users an admin linked already.                                                                                                                                                                                                       |
| `SHEAF_OIDC_USERNAME_CLAIM`      | `preferred_username`                           | Which claim names the user.                                                                                                                                                                                                                                                                          |
| `SHEAF_OIDC_NAME`                | `single sign-on`                               | What the sign-in button calls the provider.                                                                                                                                                                                                                                                          |

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

## Export and import

```sh
pnpm --filter @sheaf/ingest export ~/sheaf-backup   # every document, plus manifest.json
pnpm --filter @sheaf/ingest import ~/sheaf-backup   # into this server's SHEAF_DATA_DIR
```

Stop the server first. The export holds every document outside the trash and a
`manifest.json` with everything else a person put in:

- titles, correspondents, types, tags, dates and serial numbers;
- recognised text and notes;
- custom fields and their values;
- labels with their colours, rules and inbox flag;
- saved views.

Ids are left out. Custom fields match by name and documents by hash, so an export
imports into a server that already holds other things. Import checks every file
against its hash and reports anything it could not bring in. Running it twice
changes nothing.

Files are named by `SHEAF_FILENAME_FORMAT`. These placeholders are available:
`{{title}}`, `{{correspondent}}`, `{{document_type}}`, `{{tag_list}}`, `{{created}}`,
`{{created_year}}`, `{{created_month}}`, `{{created_day}}`, `{{added}}`,
`{{added_year}}`, `{{asn}}` and `{{sha256}}`.

Each value is made safe for a file name, and only the format's own `/` makes
folders. Names that collide get ` (2)`, ` (3)` and so on.

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
