# @sheaf/web

The desk-side client for the Sheaf server: find, read, file and share your
documents, review what the extractor read from them, add new ones, and run the
server — people, phones, workflows and settings. In English, German, French or
Spanish.

Ten pages, hash-routed: `#/search`, `#/doc/<sha256>`, `#/inbox`, `#/devices`,
`#/labels`, `#/fields`, `#/workflows`, `#/trash`, `#/users` and `#/system`. Ten
pages do not need a router library.

## Running it

```bash
pnpm --filter @sheaf/web dev
```

Opens at `http://localhost:5173`. On first load it asks for the server's URL, then
for a username and password, or the admin `SHEAF_TOKEN`. When the server has single
sign-on set up, it also offers "Sign in with …".

The **URL** is kept in `localStorage` so the app greets you next time; the
**token** — the admin token or a session — is kept in `sessionStorage` only, so
closing the tab forgets it. That is a deliberate trade-off and not a real keystore:
a token in browser storage is readable by any script on the origin, which is why it
is scoped to one tab session rather than kept around for weeks. See
`src/connection.ts`. The chosen language is kept in `localStorage` too.

## The pages

| Route                  | What it does                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#/search`             | The home page: saved views on a dashboard, then search over the server's catalog (FTS5, BM25) with filters, sorting, bulk edits and CSV export. Snippets are marked.                             |
| `#/doc/<sha>`          | The PDF, its details and custom fields with **where each came from** (`machine · 0.85` or `you`) and suggested values, notes, pages, stamps, versions, sharing, permissions and the paper trail. |
| `#/inbox`              | Upload, and documents whose machine fields nobody has accepted or corrected, with how often each suggestion has been right. Keyboard driven: `j`/`k` to move, `a` to accept, `e` to edit.        |
| `#/devices` ("Phones") | Pair a phone by QR code (or a typed code, with a live countdown), list paired phones with their last-seen, and remove one. Admins only.                                                          |
| `#/labels`             | Correspondents, document types and tags: rename, merge, colour, nest, and the rules that file new documents.                                                                                     |
| `#/fields`             | Custom fields: their types, choices, and whether every document needs one.                                                                                                                       |
| `#/workflows`          | "When this, do that": tag, file, email or call a webhook when a document arrives, changes or ages. Admins only.                                                                                  |
| `#/trash`              | Deleted documents, until they go for good: restore one, or empty it.                                                                                                                             |
| `#/users`              | People and their roles (admin, editor, viewer). Admins only.                                                                                                                                     |
| `#/system`             | The server's health, settings that can change without a restart, serial number series, and the list of recent changes.                                                                           |

Provenance on each field is the point of the document page: it is the difference
between "the model said €26.07" and "€26.07 came out of `30.00 − 3.93` on the
receipt, and you never touched it."

## Translations

Visible text goes through `t('…')` from `src/i18n.ts`, keyed by the English, with
German, French and Spanish in `src/translations/`. The language follows the
browser until someone picks one in the header. `test/i18n.test.ts` fails on any
text left untranslated, or translated but no longer used. Dates and amounts follow
the browser's own locale.

## Notes

- **Search snippets contain document text.** They are rendered as React text
  nodes split on the server's `«»` markers — never `dangerouslySetInnerHTML`.
- **Routing rejects lookalikes.** `parse()` only accepts a 64-character lowercase
  hex document id, so a crafted hash cannot navigate anywhere unexpected.
- **Deleting a document, label, field or phone, and emptying the trash, ask
  twice** — an inline second click, not `confirm()`. Removing a user or a
  workflow does not yet.

## CORS

The ingest server answers every request, from any origin, with
`Access-Control-Allow-Origin: *` — see `services/ingest/src/server.ts`. That is
deliberate, not an oversight: the token is what actually gates access, there are
no cookies for a stray origin to ride along on, and restricting the origin would
protect nothing while breaking this client. Admin routes — phones, users,
workflows, settings, the audit log, `/metrics` — need the admin token or a person
with the admin role, so a phone's token or an editor's session cannot reach them.
