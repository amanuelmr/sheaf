import type { Suggestions } from '@sheaf/core';
import type { NamedResource, RawSuggestions } from './types.ts';

/**
 * Turn Paperless's id-only suggestions into names.
 *
 * The suggestions endpoint answers in ids because it assumes the caller already
 * holds the vocabulary. An id the client has never seen is dropped rather than
 * shown: "Correspondent 47" is worse than no suggestion at all, and a stale cache
 * is the normal reason for it.
 */
export function resolveSuggestions(
  raw: RawSuggestions,
  vocabulary: {
    readonly correspondents: readonly NamedResource[];
    readonly documentTypes: readonly NamedResource[];
    readonly tags: readonly NamedResource[];
  },
): Suggestions {
  const name = (list: readonly NamedResource[], id: number): string | undefined =>
    list.find((item) => item.id === id)?.name;

  const correspondent =
    raw.correspondents?.map((id) => name(vocabulary.correspondents, id)).find(Boolean) ?? undefined;
  const documentType =
    raw.document_types?.map((id) => name(vocabulary.documentTypes, id)).find(Boolean) ?? undefined;
  const tags = (raw.tags ?? [])
    .map((id) => name(vocabulary.tags, id))
    .filter((value): value is string => value !== undefined);
  // Paperless returns dates newest-first; the most recent plausible one wins.
  const date = raw.dates?.[0];

  return {
    ...(correspondent === undefined ? {} : { correspondent }),
    ...(documentType === undefined ? {} : { documentType }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(date === undefined ? {} : { date }),
  };
}
