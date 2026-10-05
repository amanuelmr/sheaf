export interface Connection {
  readonly baseUrl: string;
  readonly token: string;
}

const URL_KEY = 'sheaf.admin.url';
const TOKEN_KEY = 'sheaf.admin.token';

/**
 * `localStorage`, not a keystore: a browser has no Keychain equivalent to put
 * this in. Honest about the trade-off rather than pretending otherwise -- this
 * is a tool a server's own operator runs on their own machine to look at a
 * token they already hold, not something handed to anyone else. The mobile
 * app's SHEAF_TOKEN gets the platform keystore because it travels with the
 * phone; this does not travel anywhere.
 */
export function loadConnection(): Connection | null {
  const baseUrl = localStorage.getItem(URL_KEY);
  const token = localStorage.getItem(TOKEN_KEY);
  if (baseUrl === null || token === null) return null;
  return { baseUrl, token };
}

export function saveConnection(connection: Connection): void {
  localStorage.setItem(URL_KEY, connection.baseUrl);
  localStorage.setItem(TOKEN_KEY, connection.token);
}

export function clearConnection(): void {
  localStorage.removeItem(URL_KEY);
  localStorage.removeItem(TOKEN_KEY);
}
