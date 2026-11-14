# Patches and overrides

Patches and overrides are a liability: they rot silently when the upstream package
moves. Each one here records what it does, why, and what should make it go away.

## Patches

None. The last one, for `expo-modules-jsi@57.0.5`, removed a `SWIFT_RETURNS_RETAINED`
annotation from two constructors that Swift 6.2 (Xcode 26) rejects. Expo fixed it
upstream in 57.1.0, and SDK 57's own packages now require that version.

## Overrides

`package.json` pins `react-native-worklets` to 0.10.1 and `react-native-reanimated`
to 4.5.1, the versions Expo tested with SDK 57.

**Why.** pnpm once resolved worklets to 0.12.1, outside the range expo-modules-core
declares (`^0.7.4 || ^0.8.0 || ^0.9.0 || ^0.10.0`). That version dropped
`WorkletRuntime::executeSync`, which expo-modules-core still calls, so the iOS build
failed.

**Remove them** when moving to an SDK whose expo-modules-core accepts the worklets
version pnpm picks on its own, after checking that `expo install --check` agrees.
They also move to `pnpm-workspace.yaml` on pnpm 11, which no longer reads the `pnpm`
field of `package.json`.
