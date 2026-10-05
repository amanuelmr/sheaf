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
