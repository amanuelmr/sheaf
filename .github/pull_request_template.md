## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## How I know it works

<!-- Which tests cover it. If sync behaviour changed, point at the test that would
     have failed before this change. -->

## Checklist

- [ ] `pnpm verify` passes
- [ ] `packages/core` is still pure (no clock, randomness, I/O, or React)
- [ ] If sync behaviour changed, a test covers it
- [ ] No token or document content can reach a log
