/** A pairing link, read before anything is sent, so the person can see where it leads. */
export type PairingLink =
  | {
      readonly ok: true;
      readonly server: string;
      readonly code: string;
      /** What the phone will connect to, exactly: no user part to hide the real host. */
      readonly host: string;
      readonly encrypted: boolean;
    }
  | { readonly ok: false };

/**
 * `server` and `code` from a `sheaf://pair` link. Refused unless the server is a
 * plain http(s) address, perhaps with a path: `https://my-nas@evil.example` would show one name and
 * connect to another.
 */
export function readPairingLink(server?: string, code?: string): PairingLink {
  if (server === undefined || code === undefined || code.trim() === '') return { ok: false };
  const match = /^(https?):\/\/([^/?#@\s]+)(\/[^?#@\s]*)?$/i.exec(server.trim());
  if (match === null) return { ok: false };
  const [, scheme, host, path = ''] = match as unknown as [string, string, string, string?];
  return {
    ok: true,
    server: `${scheme.toLowerCase()}://${host}${path.replace(/\/+$/, '')}`,
    code: code.trim(),
    host,
    encrypted: scheme.toLowerCase() === 'https',
  };
}
