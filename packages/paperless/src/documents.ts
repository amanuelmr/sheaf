import type { NamedResource, RawDocument, ResolvedDocument } from './types.ts';

const SNIPPET_LENGTH = 240;

/**
 * Turn a raw document's ids into the names a client actually shows, the same
 * split `resolveSuggestions` uses: the endpoint answers in ids because it assumes
 * the caller already holds the vocabulary, so resolving happens once here rather
 * than as a request per field per document.
 *
 * An id the vocabulary has never seen is dropped rather than shown as a bare
 * number -- a stale cache degrading to "no correspondent shown" is a much smaller
 * lie than showing the wrong one, and no id here can ever be wrong, only unknown.
 */
export function resolveDocument(
  raw: RawDocument,
  vocabulary: {
    readonly correspondents: readonly NamedResource[];
    readonly documentTypes: readonly NamedResource[];
    readonly tags: readonly NamedResource[];
  },
): ResolvedDocument {
  const name = (list: readonly NamedResource[], id: number): string | undefined =>
    list.find((item) => item.id === id)?.name;

  return {
    id: raw.id,
    title: raw.title,
    correspondent:
      raw.correspondent === null
        ? null
        : (name(vocabulary.correspondents, raw.correspondent) ?? null),
    documentType:
      raw.document_type === null
        ? null
        : (name(vocabulary.documentTypes, raw.document_type) ?? null),
    tags: raw.tags
      .map((id) => name(vocabulary.tags, id))
      .filter((value): value is string => value !== undefined),
    created: raw.created,
    contentSnippet: snippet(raw.content),
  };
}

/**
 * A short excerpt rather than the full OCR text: a list of thirty documents does
 * not need thirty full pages of content in one response, and the detail screen can
 * always ask for more.
 */
function snippet(content: string | undefined): string | null {
  if (content === undefined) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= SNIPPET_LENGTH ? trimmed : `${trimmed.slice(0, SNIPPET_LENGTH)}…`;
}
