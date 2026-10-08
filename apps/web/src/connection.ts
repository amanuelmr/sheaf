export interface Connection {
  readonly baseUrl: string;
  readonly token: string;
}

const URL_KEY = 'sheaf.web.url';
const TOKEN_KEY = 'sheaf.web.token';

/**
 * The server address is remembered; the admin token only for as long as the tab is
 * open. A browser has no keystore, and this token can create pairing codes and
 * remove phones, so it should not outlive the session that needed it.
 */
export function loadConnection(): Connection | null {
  try {
    const baseUrl = localStorage.getItem(URL_KEY);
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (baseUrl === null || token === null) return null;
    return { baseUrl, token };
  } catch {
    return null;
  }
}

export function rememberedUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveConnection(connection: Connection): void {
  try {
    localStorage.setItem(URL_KEY, connection.baseUrl);
    sessionStorage.setItem(TOKEN_KEY, connection.token);
  } catch {
    // Private windows can refuse storage; the connection still works until reload.
  }
}

export function clearConnection(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
