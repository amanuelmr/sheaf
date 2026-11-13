import { paths } from '@sheaf/protocol';
import type { Connection } from './connection';

/** The parts of sessionStorage used here, so tests can hand in their own. */
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PENDING_KEY = 'sheaf.web.sso';

interface Pending {
  readonly client: string;
  readonly server: string;
}

/**
 * Where to go to sign in with the server's provider. A random value made here is
 * kept for this tab and sent along; the server hands it back with the session, so
 * a landing this tab did not start is told apart from one it did.
 */
export function startSingleSignOn(server: string, store: Store): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const client = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const pending: Pending = { client, server };
  store.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(paths.ssoStart(), server);
  url.searchParams.set('client', client);
  return url.toString();
}

/**
 * Back from the provider: the session in the fragment, for the server this tab
 * chose before it left. The fragment's own `server` is never believed, and a
 * landing without this tab's value is refused, so a link cannot switch servers.
 */
export function finishSingleSignOn(fragment: string, store: Store): Connection | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const token = params.get('sso');
  if (token === null || token === '') return null;
  const raw = store.getItem(PENDING_KEY);
  store.removeItem(PENDING_KEY);
  if (raw === null) return null;
  let pending: Pending;
  try {
    pending = JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
  if (typeof pending.client !== 'string' || params.get('client') !== pending.client) return null;
  if (typeof pending.server !== 'string' || !/^https?:\/\//.test(pending.server)) return null;
  return { baseUrl: pending.server, token };
}
