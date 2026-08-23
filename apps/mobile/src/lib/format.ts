/**
 * Presentation helpers. Pure and clock-free — `now` is always passed in — so the
 * strings a user reads are covered by tests rather than eyeballed.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < 0) return 'just now';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function pageLabel(pages: number): string {
  return pages === 1 ? '1 page' : `${pages} pages`;
}

/** How long until the next automatic attempt, or null when none is scheduled. */
export function retryIn(nextAttemptAt: number | null, now: number): string | null {
  if (nextAttemptAt === null) return null;
  const remaining = nextAttemptAt - now;
  if (remaining <= 0) return 'trying again now';
  if (remaining < MINUTE) return `trying again in ${Math.ceil(remaining / 1_000)}s`;
  return `trying again in ${Math.ceil(remaining / MINUTE)} min`;
}

/** A short, stable handle for a document, for when there is no title yet. */
export function shortId(docId: string): string {
  return docId.slice(0, 8);
}

/** Clock time for the paper trail, in the device's own locale. */
export function clockTime(at: number): string {
  const date = new Date(at);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
