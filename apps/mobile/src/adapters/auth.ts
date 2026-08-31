import * as LocalAuthentication from 'expo-local-authentication';

/**
 * The device's own lock screen, borrowed rather than reimplemented: Face ID,
 * Touch ID, fingerprint or a PIN, whichever the person already set up. Sheaf never
 * sees the credential — the OS answers yes or no.
 *
 * A camera roll of scanned documents is tax returns, medical letters, bank
 * statements. The server connection is already gated by a token in the platform
 * keystore; this gates the screen that shows what has been captured but not yet
 * sent, which is exactly the window a token cannot protect.
 */
export async function deviceLockAvailable(): Promise<boolean> {
  const [hardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hardware && enrolled;
}

/**
 * Ask the OS to prove it is the device owner. `disableDeviceFallback: false` lets
 * the system passcode stand in when biometrics fail or are not set up for this
 * attempt — declining to be the reason someone is locked out of their own
 * documents is worth more than insisting on biometrics specifically.
 */
export async function unlockDevice(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock Sheaf',
    disableDeviceFallback: false,
  });
  return result.success;
}
