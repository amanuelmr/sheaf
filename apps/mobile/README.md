# @sheaf/mobile

Expo + Expo Router. The app's job is narrow: run effects, and render projections of
the log. Every decision about what to do next still comes from
[`@sheaf/core`](../../packages/core).

## Layout

```
app/
  index.tsx          the shutter — the app opens here, nothing in front of it
  connect.tsx        onboarding: two fields and a button
  outbox.tsx         every document and an honest account of where it is
  document/[id].tsx  the paper trail
  inbox.tsx          filing, after the fact
  settings.tsx       server, sync, privacy
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

There is no review step. Details are filed later, from Paperless's own suggestions,
because capture should never wait for a human — see
[ADR 0003](../../docs/adr/0003-upload-first-classify-later.md).

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

## What is verified, and what is not

`pnpm verify` typechecks this app under the same strict settings as the packages,
lints it, and runs the pure helpers in `src/lib`. `pnpm bundle` then builds it with
Metro — 1,211 modules into 2.7 MB of Hermes bytecode — which proves every workspace
import resolves and every screen and adapter loads. Both run in CI.

That is a real signal, and it caught two things typecheck could not: a missing
`@expo/metro-runtime` peer, and pnpm's strict symlinked layout being unresolvable by
Metro (hence `node-linker=hoisted` in the root `.npmrc`).

It still does **not** run the app. Nothing here has been executed on a device or a
simulator: no camera capture, no permission flow, no SQLite write on real hardware,
no layout at any screen size. The engine underneath it is covered by
[`@sheaf/sim`](../../packages/sim), but the wiring in `adapters/` and every screen is
compile-checked only. Treat first launch as the real test.
