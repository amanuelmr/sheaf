# Contributing to Sheaf

Thanks for looking. Sheaf is a small project, and help of every size is welcome:
a bug report, a translation, a fix or a feature.

## Ways to contribute

**Report something.** Open an [issue](https://github.com/amanuelmr/sheaf/issues/new/choose)
and pick the form that fits:

- **Bug report**: what you did, what happened, and what you expected. The history on
  a document's details screen in the phone app is the most useful thing to attach.
- **UX feedback**: something was confusing, slow, or hard to trust.
- **Feature request**: something Sheaf should do.
- **Paperless-ngx connector**: the optional connector misread your Paperless-ngx server.

Leave tokens, passwords and private documents out of an issue. Security problems go
through [SECURITY.md](SECURITY.md), not a public issue.

**Pick up something that is not done.** The README's
[Status](README.md#status) section lists it plainly. Good places to start:

- **Android.** The phone app is configured for Android but has never been built
  there. Building it, running it and saying what broke is worth a great deal.
- **The inbox swipe gesture** on the phone. The buttons work; the swipe is missing.
- **The certificate pin.** Pairing codes carry it, and the phone does not check it yet.
- **The phone app in other languages.** It is in English only; the web app's
  translations show the approach.
- **End-to-end flows on a phone.** The Maestro flows in `apps/mobile/e2e` have only
  run in the Simulator.

**Translate.** The web app is in German, French and Spanish. A new language is one
file in `apps/web/src/translations/` (see [Web app text](#web-app-text)).

**Try to break the sync engine.** Its promise is that a document arrives exactly
once, whatever fails. `pnpm chaos` kills a server under load, and `packages/sim`
replays faults from a seed. A seed that loses or duplicates a document is the best
bug report this project can get.

**Improve the docs.** If a step in the README did not work on your machine, that is
a bug in the README.

## Sending a change

1. For anything larger than a small fix, open an issue first, so the approach is
   agreed before you write it.
2. Fork the repository and make a branch.
3. Make the change, with a test that would have failed before it.
4. Run `pnpm verify` (below).
5. Open a pull request. Say what you changed, why, and how you know it works. CI
   runs on every pull request.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

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

## Commits

Small, focused commits, each with a plain description of the change.

## Security

Please don't file token handling or data leakage issues in public. See
[SECURITY.md](SECURITY.md).
