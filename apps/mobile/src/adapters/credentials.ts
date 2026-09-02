import * as SecureStore from 'expo-secure-store';

export interface ServerConfig {
  readonly baseUrl: string;
  readonly token: string;
}

const URL_KEY = 'sheaf.server.url';
const TOKEN_KEY = 'sheaf.server.token';

/**
 * What every install before profiles existed stored, and all that remains of
 * this module now: reading it once, for `profiles.ts`'s `migrateLegacyConnection`
 * to carry forward, and clearing it once that has happened. Nothing here is
 * written to any more -- see `profiles.ts` for where a connection actually lives
 * now, and SECURITY.md for why the token was in the keystore and nowhere else
 * even back when this was the only place a connection lived.
 */
export async function loadServerConfig(): Promise<ServerConfig | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (baseUrl === null || token === null) return null;
  return { baseUrl, token };
}

export async function clearServerConfig(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(URL_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}
