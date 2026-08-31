import type { NamedResource, PaperlessClient } from '@sheaf/paperless';

export interface Vocabulary {
  readonly correspondents: readonly NamedResource[];
  readonly documentTypes: readonly NamedResource[];
  readonly tags: readonly NamedResource[];
}

export interface VocabularySource {
  get(): Promise<Vocabulary>;
}

const EMPTY: Vocabulary = { correspondents: [], documentTypes: [], tags: [] };
const VOCABULARY_TTL_MS = 10 * 60_000;

/**
 * Correspondents, document types and tags, cached: every id-to-name resolution
 * this server does -- suggestions, browsing -- needs the same three lists, and
 * fetching them once per resolution would be three requests to Paperless for
 * every document shown. Shared across both callers rather than each keeping its
 * own cache, so a phone opening the library does not pay for a fetch the
 * suggestion fetcher made a minute ago.
 *
 * A stale cache degrades to a dropped name, never a wrong one -- the same
 * asymmetry `resolveSuggestions` and `resolveDocument` are built around -- so
 * there is no correctness reason to refresh eagerly.
 */
export function paperlessVocabulary(client: PaperlessClient, now: () => number): VocabularySource {
  let vocabulary = EMPTY;
  let fetchedAt = 0;

  return {
    async get(): Promise<Vocabulary> {
      if (now() - fetchedAt < VOCABULARY_TTL_MS && vocabulary !== EMPTY) return vocabulary;
      const [correspondents, documentTypes, tags] = await Promise.all([
        client.getCorrespondents(),
        client.getDocumentTypes(),
        client.getTags(),
      ]);
      if (!correspondents.ok || !documentTypes.ok || !tags.ok) return vocabulary; // keep what we had
      vocabulary = {
        correspondents: correspondents.value,
        documentTypes: documentTypes.value,
        tags: tags.value,
      };
      fetchedAt = now();
      return vocabulary;
    },
  };
}
