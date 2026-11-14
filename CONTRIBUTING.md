# Contributing to Sheaf

Thanks for looking. The most useful contributions right now are running Sheaf on
a real phone (iOS or Android) and saying what broke, translations, and scrutiny of
the sync engine. Reports from Paperless-ngx users of the optional connector are
welcome too.

## Getting set up

```bash
pnpm install
pnpm verify      # format check + lint + typecheck + tests
```

Node 24 (what `.nvmrc`, CI and the Docker image use) and pnpm.

`pnpm verify` is the everyday check. CI runs a little more: tests with coverage
floors (`pnpm test:coverage`), the search benchmark (`pnpm bench:search`), the
server actually starting, the OCR sidecar's Python tests, and production bundles of
both apps (`pnpm bundle`, `pnpm bundle:web`). Run those too if your change touches
them.

## The one rule that matters

**`packages/core` stays pure.** No I/O, no clock, no randomness, no React. Time and
jitter arrive as parameters. ESLint fails the build if you reach for `Date.now()` or
`Math.random()` in there.

This is not aesthetics. Purity is what lets the simulator replay thousands of fault
schedules deterministically, and what makes a failing seed reproducible on your
laptop instead of a story about a flaky test.

Effects belong at the edges: `apps/mobile` (the executor), `apps/web`,
`services/ingest` (the server), and the HTTP packages (`packages/http`,
`packages/client`, `packages/paperless`).

## Changing sync behaviour

Anything touching the reducer or the state machine needs a test that would have
failed before the change. Two invariants are load-bearing; if you find yourself
weakening either, please open an issue first:

1. A document with a task id is never re-uploaded.
2. A local file is never released for a document that is not confirmed synced.

## Paperless compatibility

Response shapes and consumer messages differ across Paperless-ngx versions —
`interpretTask` is the place that cares. If Sheaf misreads your server, the most
valuable thing you can send is the raw `/api/tasks/` row (with anything sensitive
redacted) and your Paperless version. That becomes a test case.

## Web app text

The web app is translated into German, French and Spanish. Put visible text through
`t('…')` from `apps/web/src/i18n.ts`, with a plain single-quoted English sentence,
and add it to each file in `apps/web/src/translations/`. A test fails on any text
left untranslated, or translated but no longer used. If you cannot translate it
yourself, say so in the PR and someone will.

## Style

Prettier and ESLint decide; don't hand-tune formatting. Write comments that explain
_why_, not what — the existing code is the reference for tone.

## Commits and PRs

Small, focused commits with a plain description of the change. In the PR, say what
you changed, why, and how you know it works.

## Security

Please don't file token handling or data leakage issues in public. See
[SECURITY.md](SECURITY.md).
