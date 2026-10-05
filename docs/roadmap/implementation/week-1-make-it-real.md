# Week 1 — Make it real (`v0.2.0`)

Goal: a sheet of paper goes from camera to server on a real phone, while someone
watches, in under a minute. Nothing in this week changes the architecture; it finds
out what the code does when a person uses it.

---

## 1.1 Run on a real iPhone (≈4 h)

**Why.** `ARCHITECTURE.md` says it plainly: the app has never been tapped. Every
later week builds on the phone working.

### Steps

1. **Start a server on your LAN** (no Docker needed):
   ```bash
   export SHEAF_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   echo $SHEAF_TOKEN   # you will type/paste this into the phone once
   pnpm --filter @sheaf/ingest start
   ```
   Note your Mac's LAN IP (`ipconfig getifaddr en0`). The server listens on all
   interfaces on port 8787 (`server.listen(port)` in `services/ingest/src/main.ts`).
2. **Build to the device.** Plug in the iPhone, trust the Mac, enable Developer Mode
   (Settings → Privacy & Security). A free Apple ID is enough for a 7-day signing
   profile; set the team in Xcode once (`apps/mobile/ios/Sheaf.xcworkspace` →
   Signing & Capabilities).
   ```bash
   pnpm --filter @sheaf/mobile exec expo run:ios --device
   ```
3. **Connect.** In the app: `http://<lan-ip>:8787` and the token. iOS will show the
   local-network permission prompt (`NSLocalNetworkUsageDescription` is already in
   `app.json`). Accept it.
4. **Run the field-test script** below, in order, and log every surprise in
   `field-notes.md` with the date.

### Field-test script

| #   | Do                                                        | Expect                                                             |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| F1  | First launch, deny camera, then allow from Settings       | App explains and recovers without a restart                        |
| F2  | Scan one receipt with the platform scanner                | Outbox shows it; server log shows `PUT` 201                        |
| F3  | Batch: 10 pages, without leaving the camera               | 10 documents (or 1 multi-page, per your UI choice), all synced     |
| F4  | Flight mode on, scan 5 documents, flight mode off         | All 5 arrive; none twice (`GET /v1/documents` count)               |
| F5  | Start a big upload, swipe the app away mid-upload, reopen | Reconciles with `HEAD`, does not re-upload (server log)            |
| F6  | Scan the same receipt twice                               | Second capture flagged as familiar (pHash), not a silent duplicate |
| F7  | Stop the server, scan, restart server 2 minutes later     | Backoff, then delivery, with the paper trail showing the attempts  |
| F8  | Enable the device lock in Settings, background, reopen    | Face ID prompt before anything is visible                          |
| F9  | Search the outbox for a word on the receipt               | On-device OCR finds it before sync                                 |
| F10 | Add a second profile, switch, scan                        | Lands on the second server only                                    |

### Fixing what breaks

- One defect → one commit, with a regression test when the logic is testable off-
  device (most is: `core`, `engine`, `store`, `client`, `apps/mobile/src/lib`).
- Native-only defects (permissions, layout) get a line in `field-notes.md` with a
  screenshot; there is no unit test to write, so the Maestro flow (1.4) is their test.

**Acceptance.** F1–F10 all pass on one real iPhone. Field notes committed.

**Traps.**

- iOS blocks plain HTTP except to local networks; `NSAllowsLocalNetworking` is set,
  so `http://192.168.x.x` works but `http://my-server.example` does not. Use HTTPS
  for anything not on the LAN.
- If the Mac's firewall is on, allow incoming connections for `node`.
- The free-provisioning profile expires after 7 days; rebuild when the app stops
  launching.

---

## 1.2 Android build (≈2 h)

### Steps

1. Install Android Studio (SDK + an emulator image with Google Play, which the
   ML Kit document scanner requires), or use a physical device with USB debugging.
2. **Allow plain HTTP to the LAN server.** Android blocks cleartext by default.
   Add `expo-build-properties` and configure it in `apps/mobile/app.json`:
   ```bash
   pnpm --filter @sheaf/mobile exec expo install expo-build-properties
   ```
   ```json
   ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
   ```
   Note the trade-off in a comment next to it, the same way the iOS setting is
   justified: it is needed for a home server without TLS.
3. Build and run:
   ```bash
   pnpm --filter @sheaf/mobile exec expo run:android
   ```
   No local toolchain? Use EAS: `npx eas-cli build --profile development --platform android`
   after adding an `eas.json` with a `development` profile (`developmentClient: true`).
4. Re-run F2–F7 from the field-test script.

**Acceptance.** F2–F7 pass on Android. `app.json` change committed with its reasoning.

**Traps.**

- The emulator reaches the host Mac at `10.0.2.2`, not `localhost`.
- `react-native-document-scanner-plugin` uses the ML Kit Document Scanner, which needs
  Google Play services; an emulator image without Play falls back to the hand-crop
  path (`manual` in `app/index.tsx`). Test both.
- Commit `android/` only if you decide to stop using prebuild; otherwise keep it
  ignored like `ios/build`.

---

## 1.3 Contract tests against Paperless 3.x (≈2 h)

**Why.** Paperless 3.0 redesigned its tasks API and dropped API versions below 9.
`packages/paperless/src/tasks.ts` reads task shapes; the forwarder depends on it.

### Steps

1. Run the suite as-is: `pnpm run test:contract`. Its compose file pins
   `paperless-ngx:latest`, which is now 3.x.
2. For each failure, read the real response (the suite logs it), then fix the
   interpreter in `packages/paperless/src/tasks.ts` or `client.ts`.
   **Add a unit test in `packages/paperless/test/interpret.test.ts` using the exact
   real payload** before fixing. That is the habit ADR 0002 records.
3. **Send an explicit API version header.** `packages/paperless/src` does not
   send one today. Paperless negotiates via `Accept: application/json; version=N`. Pin the version the tests pass
   against, so a future default change cannot silently alter shapes.
4. **Pin the image** in both `packages/paperless/test/contract/docker-compose.yml` and
   the root `compose.yml` to the exact tag you tested (find it with
   `docker image inspect ghcr.io/paperless-ngx/paperless-ngx:latest --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`).
5. **Schedule it in CI.** New workflow `.github/workflows/contract.yml`: `schedule`
   weekly plus `workflow_dispatch`, `ubuntu-latest` (Docker is preinstalled), runs
   `pnpm run test:contract`. A red weekly run means Paperless changed under you,
   which is exactly when you want to know.

**Acceptance.** Contract suite green against a pinned 3.x tag; weekly workflow exists.

---

## 1.4 Maestro end-to-end smoke flow (≈2 h)

**Why.** The phone has no automated test that taps anything. One flow makes "it
works" a repeatable claim instead of a memory.

### Steps

1. Install: `curl -fsSL "https://get.maestro.mobile.dev" | bash`.
2. **Add a test seam for the camera.** The simulator has no camera, so add a
   fixture scanner, enabled only by a build-time flag:
   - In `apps/mobile/src/adapters/scanner.ts`, if
     `process.env.EXPO_PUBLIC_SHEAF_E2E === '1'`, return
     `{ kind: 'pages', uris: [<bundled fixture>] }` instead of calling the plugin.
   - Bundle one fixture JPEG (reuse `packages/pdf/test/fixtures/photo-small.jpg`,
     copied to `apps/mobile/assets/e2e/receipt.jpg`) and resolve it with
     `Asset.fromModule(...).downloadAsync()` to get a file URI.
   - Expo inlines `EXPO_PUBLIC_*` at build time, so a production build cannot
     reach this branch by accident. Say so in a comment.
3. **Add `testID`s** to the elements the flow touches: connect fields and button,
   shutter, outbox link, the outbox row, and its status text. `Button` in
   `src/ui/components.tsx` needs to pass `testID` through.
4. Write `apps/mobile/e2e/smoke.yaml`:
   ```yaml
   appId: dev.sheaf.capture
   env:
     SERVER: http://localhost:8787
   ---
   - launchApp: { clearState: true }
   - tapOn: { id: connect-url }
   - inputText: ${SERVER}
   - tapOn: { id: connect-token }
   - inputText: ${TOKEN}
   - tapOn: { id: connect-submit }
   - assertVisible: 'You’re ready.'
   - tapOn: 'Scan your first document'
   - tapOn: { id: shutter }
   - tapOn: { id: open-outbox }
   - extendedWaitUntil: { visible: 'Synced', timeout: 20000 }
   ```
5. Script it: `apps/mobile/package.json` → `"e2e": "maestro test e2e"`. Document the
   one-time setup in `apps/mobile/README.md` (start server with a known token, build
   with `EXPO_PUBLIC_SHEAF_E2E=1 expo run:ios`, run `TOKEN=... pnpm e2e`).
6. CI is optional this week (macOS runners are slow and costly). Add a
   `workflow_dispatch`-only job later or use Maestro Cloud's free tier.

**Acceptance.** `pnpm --filter @sheaf/mobile e2e` passes locally against a simulator.

**Traps.** Maestro waits on the accessibility tree; `testID` maps to the iOS
accessibility identifier, but text inside custom `Pressable`s may need
`accessibilityLabel` too.

---

## 1.5 Rewrite the README front page (≈1.5 h)

### Steps

1. Capture media from the real device: three screenshots (camera, outbox with a
   paper trail open, library search) and one 20–30 second GIF of F4 (flight-mode batch,
   then everything landing). Save under `docs/media/`. Keep files under ~3 MB each.
2. Restructure the top of `README.md`:
   - Tagline, then the GIF.
   - **Three numbers**: tests, simulated process kills with 0 lost / 0 duplicated,
     and "runs on iOS and Android".
   - Quick start that works first time (copy the commands from 1.1).
   - Replace the stale **Status** table (it still says `apps/mobile` is not started)
     with a short "What works today" list.
   - Link `docs/roadmap/`.
3. Keep everything below the fold (the engineering sections) as is. It is good.

**Acceptance.** A friend who has never seen the project can say what it does and
start the server from the README alone. Ask one.

---

## 1.6 Demo video (≈1 h, ✂ cut first)

90 seconds, screen recording plus phone camera: flight mode on → scan 5 → show the
outbox waiting → flight mode off → all land → open a paper trail. Upload unlisted
to YouTube; link from README.

---

## End of week 1

- `CHANGELOG.md`: move items under `## 0.2.0 — <date>`.
- `git tag v0.2.0 && git push --tags`; create a GitHub release with the GIF.
