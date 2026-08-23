/** Shape of a row from GET /api/tasks/. Fields vary by Paperless version. */
export interface PaperlessTask {
  readonly task_id: string;
  readonly status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | (string & {});
  readonly result?: string | null;
  readonly related_document?: number | string | null;
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

/** The fields of a document list row that reconciliation depends on. */
export interface DocumentSummary {
  readonly id: number;
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
