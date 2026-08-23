# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/amanuelmr/sheaf/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it, and what
you think the impact is. I will acknowledge as quickly as I can.

## What Sheaf handles

Sheaf holds two sensitive things: a Paperless-ngx API token, and images of documents
that may contain almost anything.

**The token.** Stored only in the platform keystore (iOS Keychain / Android
Keystore), never in plain app storage. It must never appear in a log, a crash
report, an error message, an analytics event, or a screenshot. `Authorization`
headers are redacted before anything is written anywhere.

**Documents.** They travel directly from the device to the user's own server. There
is no Sheaf backend and no third party in the path. A local file is never deleted
until the server has confirmed it has the document, and never at all if the user's
retention policy says to keep it.

**Transport.** A certificate failure is treated as a blocking error that stops the
upload and asks the user — never as a retryable one, and never silently bypassed.

## Scope

In scope: token handling and storage, log or crash-report leakage of tokens or
document content, local file handling, TLS validation, and anything that could send a
document somewhere the user did not choose.

Out of scope: vulnerabilities in Paperless-ngx itself (report those to
[paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)), and issues that
require an already-compromised device.
