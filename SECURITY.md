# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/amanuelmr/sheaf/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it, and what
you think the impact is. I will acknowledge as quickly as I can.

Only the latest commit on `main` is supported; there are no maintained release
branches yet.

## What Sheaf holds

Sheaf is a phone app, a web app and a server you run yourself. There is no Sheaf
cloud service and no telemetry: documents go from your devices to your server, and
from there only to the places you configure.

The server holds:

- **Documents** and the text read from them, which may contain almost anything.
- **Credentials**: the admin token (`SHEAF_TOKEN`), people's passwords, sessions,
  paired phones' tokens, share links, and the secrets for the places it sends or
  fetches documents (WebDAV, S3, Papra, an IMAP mailbox, an SMTP server, a single
  sign-on provider, an AI provider, and optionally a Paperless-ngx server).

## How it protects them

**Who may ask.** Every route but sign-in, pairing, single sign-on and share links
needs a bearer token: the admin token, a person's session, or a paired phone's
token.

- The admin token is compared in constant time.
- Passwords are stored only as scrypt hashes, each with its own salt.
- Session tokens and phone tokens are random 256-bit values, stored only as SHA-256
  hashes, so a copy of the database does not let anyone sign in.
- A wrong password costs the same time as an unknown username, and repeated wrong
  passwords lock the account for fifteen minutes.
- Pairing codes are one-time, expire after five minutes, and are rate-limited.
- Sessions last 30 days and end at sign-out. Disabling a person ends theirs at once.

**What each person may see.** People have roles: admin, editor or viewer. A viewer
cannot change anything.

- A document belongs to whoever uploaded it, and is shared with others only when
  they choose; search, similar-document hints and custom field suggestions only
  draw on documents the person may see.
- Admin pages (users, phones, workflows, settings) refuse everyone but admins.
- Changes made through the API are written to an audit log.

**Single sign-on** (OpenID Connect) uses PKCE, `state` and `nonce`. The ID token's
signature is checked against the provider's published keys.

**Share links** are random 192-bit addresses that open one document without a
token. They can expire, and can be revoked. Anyone with the link can read the
document, so treat a link like the document itself.

**At rest.** With `SHEAF_ENCRYPTION_KEY` set, every document file is encrypted with
AES-256-GCM, with a key derived from it by scrypt. Files stored before the key was
set are encrypted in the background. The database, which holds titles, extracted
text and notes, is not encrypted by Sheaf: keep the data directory on an encrypted
disk if that matters to you. Losing the key loses the documents.

**In transit.** Run the server behind HTTPS, either a reverse proxy or its own
(`SHEAF_TLS_CERT` and `SHEAF_TLS_KEY`). Each pairing code carries the
certificate's public key pin (`sha256/…`), or the proxy's with `SHEAF_TLS_PIN`.
The phone app does not enforce the pin yet; until it does, a phone trusts what
its operating system trusts. Plain HTTP is accepted for a server on your own
network, and the phone app allows it, so anyone on that network can read the
traffic.

**On the phone.** The phone's token is kept only in the platform keystore (iOS
Keychain, Android Keystore). The app can require Face ID or a fingerprint to open.
A scan is never deleted from the phone until the server has confirmed it has it. A
certificate error stops the upload and is shown; it is never retried past or
ignored.

**Logs.** `Authorization` headers and tokens are never logged. Document text is
not logged.

## Where documents can leave the server

Only to places you configure:

- **Copies**: a WebDAV server, a folder, an S3 bucket, Papra or Paperless-ngx. Their
  credentials live in the server's environment.
- **AI extraction**, when you choose Claude or another provider over the built-in
  extractor: the document's text is sent to that provider, which the server log
  says when it starts. Ollama keeps it on a machine you run.
- **Email**, when a workflow sends a document.
- **Share links**, to whoever has the link.
- **The post-consume script**, which runs with the server's permissions and gets a
  plain copy of each new document. Only the person running the server can set it.

## Untrusted input

Files and mail come from outside, so the server reads them defensively:

- An upload must hash to the address it is sent to, and is limited in size.
- A PDF must start with `%PDF-`. EPUBs are unpacked with limits on size and
  number of files, so a ZIP bomb is refused.
- Email is parsed only to find PDF and EPUB attachments; nothing else in a
  message is run or followed. Nesting depth is limited.
- CSV exports neutralise cells that a spreadsheet would read as formulas.
- Paths built from document titles, such as export and copy file names, are kept
  inside their folder.

## Known limits

- CORS is open to every origin on purpose: access depends on the bearer token, and
  there are no cookies for another site to borrow. A token pasted into a page you
  do not trust is a token given away.
- The admin token is all-powerful and is the one thing that cannot be rotated
  without a restart. Prefer personal accounts for daily use.

## Scope

In scope:

- authentication, sessions, tokens and permissions;
- reading a document you were not allowed to see;
- leaks of tokens or document content through logs, errors or crash reports;
- encryption at rest, TLS handling and pinning;
- parsing of uploaded files and email;
- anything that sends a document somewhere you did not choose.

Out of scope:

- vulnerabilities in other software Sheaf connects to (report those to its
  maintainers);
- attacks that need an already compromised device or server;
- what someone with the admin token can do.
