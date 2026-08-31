import { resolveSuggestions, type NamedResource, type PaperlessClient } from '@sheaf/paperless';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { Suggestions } from '@sheaf/protocol';
import type { SuggestionSource } from './suggestion-fetcher.ts';

interface Vocabulary {
  readonly correspondents: readonly NamedResource[];
  readonly documentTypes: readonly NamedResource[];
  readonly tags: readonly NamedResource[];
}

const EMPTY: Vocabulary = { correspondents: [], documentTypes: [], tags: [] };
const VOCABULARY_TTL_MS = 10 * 60_000;

/**
 * Paperless-ngx as a suggestion source. Suggestions come back as ids -- the
 * classifier assumes the caller already holds the vocabulary -- so this fetches
 * and caches correspondents, document types and tags to turn them into the names
 * the phone actually shows. The same cache this project already had on the phone,
 * before it stopped needing one there: a stale cache degrades to a dropped
 * suggestion, never to a wrong one, and a document is safe either way.
 */
export function paperlessSuggestionSource(
  client: PaperlessClient,
  now: () => number,
): SuggestionSource {
  let vocabulary = EMPTY;
  let fetchedAt = 0;

  async function refresh(): Promise<void> {
    if (now() - fetchedAt < VOCABULARY_TTL_MS && vocabulary !== EMPTY) return;
    const [correspondents, documentTypes, tags] = await Promise.all([
      client.getCorrespondents(),
      client.getDocumentTypes(),
      client.getTags(),
    ]);
    if (!correspondents.ok || !documentTypes.ok || !tags.ok) return; // keep what we had
    vocabulary = {
      correspondents: correspondents.value,
      documentTypes: documentTypes.value,
      tags: tags.value,
    };
    fetchedAt = now();
  }

  return {
    async get(remoteId: string): Promise<ApiResult<Suggestions>> {
      const documentId = Number(remoteId);
      if (!Number.isInteger(documentId)) {
        // Not a Paperless id at all -- asking again cannot change that.
        return err({
          kind: 'rejected',
          status: 0,
          message: `not a Paperless document id: ${remoteId}`,
        });
      }

      const raw = await client.getSuggestions(documentId);
      if (!raw.ok) return err(raw.reason);

      await refresh();
      return ok(resolveSuggestions(raw.value, vocabulary));
    },
  };
}
