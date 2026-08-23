# Contributing to Sheaf

Thanks for looking. Sheaf is early, so the most useful contributions right now are
Paperless-ngx compatibility reports and scrutiny of the sync engine.

## Getting set up

```bash
pnpm install
pnpm verify      # format check + lint + typecheck + tests
```

Node 20+ and pnpm. CI runs exactly `pnpm verify`, so a green local run is a green PR.

## The one rule that matters

**`packages/core` stays pure.** No I/O, no clock, no randomness, no React. Time and
jitter arrive as parameters. ESLint fails the build if you reach for `Date.now()` or
`Math.random()` in there.

This is not aesthetics. Purity is what lets the simulator replay thousands of fault
schedules deterministically, and what makes a failing seed reproducible on your
laptop instead of a story about a flaky test.

Effects belong in `apps/mobile` (the executor) or `packages/paperless` (HTTP).

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

## Style

Prettier and ESLint decide; don't hand-tune formatting. Write comments that explain
_why_, not what — the existing code is the reference for tone.

## Commits and PRs

Small, focused commits with a plain description of the change. In the PR, say what
you changed, why, and how you know it works.

## Security

Please don't file token handling or data leakage issues in public. See
[SECURITY.md](SECURITY.md).
