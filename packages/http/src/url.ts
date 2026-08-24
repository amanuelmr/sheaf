/** Join a base URL and a path without producing `//` or dropping a path prefix. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return `${base}/${suffix}`;
}

/**
 * Remove the API token from any text before it can reach an error message, a log,
 * or a crash report. Called on every string this package puts into an error.
 *
 * SECURITY.md promises the token never appears in output; this is where that is
 * actually enforced.
 */
export function redact(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join('[redacted]');
}
