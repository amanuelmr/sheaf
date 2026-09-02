/** Shape of a row from GET /api/tasks/. Fields vary by Paperless version. */
export interface PaperlessTask {
  readonly task_id: string;
  readonly status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | (string & {});
  readonly result?: string | null;
  readonly related_document?: number | string | null;
  /** What a real Paperless-ngx v3 actually sends instead of `related_document`. */
  readonly related_document_ids?: readonly (number | string)[] | null;
  /** The name the file was uploaded under. Present from the moment it is accepted. */
  readonly task_file_name?: string | null;
}

export interface ServerInfo {
  readonly version: string | null;
  readonly host: string;
}

/** A correspondent, document type, or tag: an id and a human-readable name. */
export interface NamedResource {
  readonly id: number;
  readonly name: string;
}

/**
 * GET /api/documents/{id}/suggestions/ answers in ids, not names — it assumes the
 * caller already holds the vocabulary. Resolving happens above this layer.
 */
export interface RawSuggestions {
  readonly correspondents?: readonly number[];
  readonly tags?: readonly number[];
  readonly document_types?: readonly number[];
  readonly dates?: readonly string[];
}

/** Field names as the API expects them, so nothing has to be renamed in flight. */
export interface DocumentPatch {
  readonly title?: string;
  readonly correspondent?: number | null;
  readonly document_type?: number | null;
  readonly tags?: readonly number[];
  readonly created?: string;
}

/**
 * The fields of a document list row that reconciliation depends on.
 *
 * Both spellings are declared deliberately. Paperless filters on
 * `original_filename__istartswith` but returns the value as `original_file_name` --
 * the parameter and the field are spelled differently. Reading only the spelling
 * that appears in the query meant every candidate failed its re-check, so
 * reconciliation reported "not found" for documents that were plainly there.
 */
export interface DocumentSummary {
  readonly id: number;
  /** What a current server returns. */
  readonly original_file_name?: string | null;
  /** Older spelling, kept so this works across versions. */
  readonly original_filename?: string | null;
  readonly title?: string | null;
}

/** Whether this server's document filter can be relied on to narrow results. */
export interface ReconcileProbe {
  readonly filterSupported: boolean;
  /** False when the server had no documents to test the filter against. */
  readonly conclusive: boolean;
  readonly detail: string;
}

/**
 * A row from `GET /api/documents/` or `GET /api/documents/{id}/` -- the browsing
 * shape, distinct from `DocumentSummary`, which only carries what reconciliation
 * needs. Correspondent, type and tags are ids here for the same reason
 * `RawSuggestions` are: resolving them to names is the caller's job, once, using
 * the cached vocabulary rather than a request per field per document.
 */
export interface RawDocument {
  readonly id: number;
  readonly title: string;
  readonly correspondent: number | null;
  readonly document_type: number | null;
  readonly tags: readonly number[];
  readonly created: string;
  /** Full OCR text. Present on both the list and detail shapes. */
  readonly content?: string;
}

export interface RawDocumentList {
  readonly count: number;
  readonly results: readonly RawDocument[];
}

/** What browsing the archive resolves ids and content down to for a client. */
export interface ResolvedDocument {
  readonly id: number;
  readonly title: string;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly created: string;
  /** A short excerpt of the OCR text, or null when there is none yet. */
  readonly contentSnippet: string | null;
}

/** What `GET /api/documents/` is asked to narrow down. */
export interface DocumentQuery {
  /** Full-text search, over title and OCR content. */
  readonly text?: string;
  /** 1-based. */
  readonly page?: number;
  /** Left unset, Paperless's own default applies -- set explicitly to know it. */
  readonly pageSize?: number;
  readonly correspondentId?: number;
  readonly documentTypeId?: number;
  readonly tagId?: number;
}

/** A document to change: only the fields present are touched. */
export interface ArchivePatch {
  readonly title?: string;
  readonly correspondentId?: number | null;
  readonly documentTypeId?: number | null;
  readonly tagIds?: readonly number[];
}

/**
 * Bytes with the content type the server actually sent -- carried along rather
 * than assumed, because Paperless's thumbnail format is a server-side setting
 * (WebP by default, PNG on an older or reconfigured instance) and guessing wrong
 * would mislabel the image rather than fail loudly.
 */
export interface BinaryFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}
