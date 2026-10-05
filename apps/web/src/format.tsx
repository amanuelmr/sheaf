import type { ReactNode } from 'react';

/** A search snippet with its «matches» marked, as text nodes: never parsed as HTML. */
export function Snippet({ text }: { text: string }): ReactNode {
  return text
    .split(/(«[^»]*»)/)
    .map((part, i) =>
      part.startsWith('«') && part.endsWith('»') ? <mark key={i}>{part.slice(1, -1)}</mark> : part,
    );
}

export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortSha(sha256: string): string {
  return sha256.slice(0, 8);
}

/** Money as the server stores it (integer minor units), shown as people read it. */
export function money(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { minor, currency } = value as { minor?: unknown; currency?: unknown };
  if (typeof minor !== 'number' || typeof currency !== 'string') return null;
  const digits = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      minor / 10 ** digits,
    );
  } catch {
    return `${currency} ${(minor / 10 ** digits).toFixed(digits)}`;
  }
}
