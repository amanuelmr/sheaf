/**
 * What's kept of a document someone actually opened, or starred, from the
 * archive -- deliberately a smaller shape than `ArchiveDocument`: there is
 * nowhere to put a live PDF preview offline, only the thumbnail already fetched
 * for it, and no reason to duplicate `ArchiveDocument` itself when this is what
 * gets stored instead.
 */
export interface CachedDocument {
  readonly id: number;
  readonly title: string;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly created: string;
  readonly contentSnippet: string | null;
  /** A local file path, or null when the thumbnail could not be fetched. */
  readonly thumbnailPath: string | null;
  /** Exempt from eviction. Set explicitly; never implied by being viewed. */
  readonly starred: boolean;
  /** When this row was last written -- by a view, not by when it was starred. */
  readonly cachedAt: number;
}
