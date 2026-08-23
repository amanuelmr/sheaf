import * as SecureStore from 'expo-secure-store';

export interface ServerConfig {
  readonly baseUrl: string;
  readonly token: string;
}

const URL_KEY = 'sheaf.server.url';
const TOKEN_KEY = 'sheaf.server.token';

/**
 * The token lives in the platform keystore (Keychain / Android Keystore) and
 * nowhere else. It is never written to the database, never logged, and never put
 * in a URL — see SECURITY.md, and the redaction tests in `@sheaf/paperless`.
 */
export async function loadServerConfig(): Promise<ServerConfig | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (baseUrl === null || token === null) return null;
  return { baseUrl, token };
}

export async function saveServerConfig(config: ServerConfig): Promise<void> {
  await SecureStore.setItemAsync(URL_KEY, config.baseUrl);
  await SecureStore.setItemAsync(TOKEN_KEY, config.token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearServerConfig(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(URL_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}
