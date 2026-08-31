import { resolveSuggestions, type PaperlessClient } from '@sheaf/paperless';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { Suggestions } from '@sheaf/protocol';
import type { VocabularySource } from './paperless-vocabulary.ts';
import type { SuggestionSource } from './suggestion-fetcher.ts';

/**
 * Paperless-ngx as a suggestion source. Suggestions come back as ids -- the
 * classifier assumes the caller already holds the vocabulary -- so this resolves
 * them to the names the phone actually shows, using the shared cache in
 * `paperless-vocabulary.ts`.
 */
export function paperlessSuggestionSource(
  client: PaperlessClient,
  vocabulary: VocabularySource,
): SuggestionSource {
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

      return ok(resolveSuggestions(raw.value, await vocabulary.get()));
    },
  };
}
