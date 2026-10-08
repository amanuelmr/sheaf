# Field notes

A dated line for every surprise found while building the roadmap, especially on real
devices. This is the raw material for the write-up in step 4.5.

## Environment

| Tool    | Version                                |
| ------- | -------------------------------------- |
| Xcode   | 26.2                                   |
| Node    | 24.21.0                                |
| pnpm    | 10.30.2                                |
| Docker  | 28.5.2                                 |
| iPhone  | _model / iOS version — fill in at 1.1_ |
| Android | _not installed yet (no SDK, no adb)_   |
| Maestro | _not installed yet_                    |

## Notes

- 2026-10-05 — `pnpm verify` failed on a clean checkout because Prettier checked
  Expo's generated `apps/mobile/expo-env.d.ts`. Ignored it; CI is a real signal again.
- 2026-10-05 — Contract suite against a real Paperless-ngx **3.2.1**: 11/11 pass.
  The v3 tasks redesign and the API-version cut did not touch anything Sheaf reads,
  so no client change was needed. Pinned the contract stack to 3.2.1; a weekly
  workflow also runs `latest` as an early warning. The image download took ~45
  minutes on this connection, which is worth knowing before a demo.
- 2026-10-06 — Paperless-ngx **3.3.0** was published at 03:55Z, hours after the
  stack was pinned to 3.2.1 and verified against it. The pin stays at 3.2.1 on
  purpose: the weekly `latest` leg of the contract workflow is what tests a new
  version before anyone is asked to move. `latest` therefore becomes 3.3.0 on the
  next scheduled run, and a red advisory leg there is the expected signal rather
  than a surprise.
- 2026-10-06 — A review of the merged work found two of our own claims that
  measurement contradicted: the mobile README's bundle size (1,211 modules) was
  stale — a fresh bundle reports 1,251 — and the research note still said the
  contract suite pinned `latest` after the pin had landed. Both are the kind of
  number nobody re-measures once it is written down.
- 2026-10-06 — The end-to-end fixture reaches the scanner by short-circuiting
  `scanDocument()`, where the plan said to go "via the hand-crop fallback path".
  The short circuit is better (no camera UI in a test at all), but it means the
  manual crop screen and the manual fallback branch have **zero** end-to-end
  coverage. Recorded so nobody reads a green flow as "the camera path works".
- 2026-10-06 — The 21 KB end-to-end fixture does ship in a release export, because
  its import is unconditional; only the branch that reads it is unreachable, since
  `EXPO_PUBLIC_*` is inlined at bundle time. The comment claimed the whole thing
  was dead code, which was half true.
