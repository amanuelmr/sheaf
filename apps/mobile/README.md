# @sheaf/mobile

Expo + Expo Router. The app's job is narrow: run effects, and render projections of
the log. Every decision about what to do next still comes from
[`@sheaf/core`](../../packages/core).

## Layout

```
app/
  index.tsx          the shutter — the app opens here, nothing in front of it
  connect.tsx        onboarding: two fields and a button
  outbox.tsx         every document, with a picture of it and where it has got to
  document/[id].tsx  one document: preview, details you can edit, full history
  settings.tsx       server, sync, scanning, storage, privacy
src/
  adapters/          the impure edges: sqlite, keystore, files, HTTP
  runtime/           the tick loop and the React wiring
  ui/                the few primitives every screen is built from
  lib/               pure helpers (tested in Node)
  theme.ts           tokens: 8pt spacing, one accent, designed dark mode
```

## The shutter

A tap assembles the pages into a deterministic PDF, hashes it, writes the bytes to
`documents/<sha256>.pdf`, and appends `Captured` + `Enqueued`. The sync loop takes
it from there.

A captured page goes through a short editor first — rotate and crop, nothing that
asks a question. That is not the review step ADR 0003 removed: on a real receipt,
being turned upright and trimmed took OCR from 56 characters of noise to 257 of
readable text. Details are filed afterwards, on the document screen, long after the
document is safe.

Order matters in one place: the bytes reach disk **before** the event does, so a log
entry can never describe a document that is not there.

## Adapters

|                  |                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.ts`    | `expo-sqlite` behind the store's driver interface, so the schema that runs here is the one tested against `node:sqlite`. WAL and `synchronous = FULL`, because the log is the only record that a document exists. |
| `credentials.ts` | The token, in the platform keystore and nowhere else.                                                                                                                                                             |
| `files.ts`       | Content-addressed local storage: a path can never point at the wrong document.                                                                                                                                    |
| `api.ts`         | `EngineApi` over the real client, with a cached vocabulary for naming suggestions.                                                                                                                                |

## The tick loop

`SyncService` decides _when_ to ask, never _what_ to do. It ticks on an interval, on
foreground, and on reconnect — and `resuming` is true for exactly the first tick of a
process, which is what turns an upload interrupted by a kill into a reconciliation
rather than a blind re-send.

## Running it

```bash
pnpm install
pnpm --filter @sheaf/mobile start
```

Needs a development build rather than Expo Go, because `expo-sqlite`,
`expo-secure-store` and `expo-camera` are native modules.

### Android

```bash
pnpm --filter @sheaf/mobile exec expo run:android
```

Needs Android Studio's SDK and an emulator image **with Google Play**, which the
platform document scanner (ML Kit) depends on; without Play the app falls back to
the hand-drawn crop. The emulator reaches a server on the host Mac at `10.0.2.2`,
not `localhost`.

`app.json` sets `usesCleartextTraffic` through `expo-build-properties`. Android
refuses plain HTTP by default, and a server on your own network usually has no
certificate. It is the Android side of the choice iOS makes with
`NSAllowsLocalNetworking`, but wider: Android cannot limit it to local addresses, so
a server reachable over the internet should still be HTTPS.

### iOS

The iOS build requires one patched dependency: `expo-modules-jsi@57.0.5` annotates
two constructors with `SWIFT_RETURNS_RETAINED`, which Swift 6.2 (Xcode 26) rejects.
It is a two-line, verified-redundant removal — see [`patches/README.md`](../../patches/README.md).

## End-to-end tests

[Maestro](https://maestro.mobile.dev) flows live in `e2e/`. A simulator has no
camera, so the flows need a build where the shutter scans a bundled page
(`assets/e2e/page.jpg`) instead. That build is chosen at bundle time with
`EXPO_PUBLIC_SHEAF_E2E=1`, and a build made without it cannot reach that path.

One-time setup: Java 17+, Maestro 1.40 or newer, and
`curl -fsSL "https://get.maestro.mobile.dev" | bash`. `pnpm e2e` checks both and
says how to install what is missing; Maestro is a global CLI rather than a
dependency because adding it to `package.json` would still not install a JVM.

```bash
# 1. A server with a known token, in one terminal
SHEAF_TOKEN=e2e-token-0123456789 pnpm --filter @sheaf/ingest start

# 2. A test build on a booted simulator, in another
EXPO_PUBLIC_SHEAF_E2E=1 pnpm --filter @sheaf/mobile exec expo run:ios

# 3. The flows
TOKEN=e2e-token-0123456789 pnpm --filter @sheaf/mobile e2e
```

Every selector in a flow is a `testID`, so rewording a label cannot break a test.
Rows in a list are named after what they show — `outbox-row-<short id>` — so an
assertion still says which document it means when several are on screen.

**What the flows do not cover:** `EXPO_PUBLIC_SHEAF_E2E=1` short-circuits
`scanDocument()` before the platform scanner is called, so nothing past the shutter
exercises the camera. In particular the hand-drawn crop screen and the manual
fallback branch have **no** end-to-end coverage — a green flow means "capture,
store and sync work", not "the camera path works".

## What is verified, and what is not

`pnpm verify` typechecks this app under the same strict settings as the packages,
lints it, and runs the pure helpers in `src/lib`. `pnpm bundle` then builds it with
Metro — 1,251 modules into 2.8 MB of Hermes bytecode — which proves every workspace
import resolves and every screen and adapter loads. Both run in CI.

That is a real signal, and it caught two things typecheck could not: a missing
`@expo/metro-runtime` peer, and pnpm's strict symlinked layout being unresolvable by
Metro (hence `node-linker=hoisted` in the root `.npmrc`).

It still does **not** run the app. Nothing here has been executed on a device or a
simulator: no camera capture, no permission flow, no SQLite write on real hardware,
no layout at any screen size. The engine underneath it is covered by
[`@sheaf/sim`](../../packages/sim), but the wiring in `adapters/` and every screen is
compile-checked only. Treat first launch as the real test.
