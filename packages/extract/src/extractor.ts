import type { ApiResult } from '@sheaf/http';
import type { DateOrder } from './normalise.ts';
import type { ExtractedFields } from './schema.ts';

/** Names already in the archive, so an extractor reuses them instead of inventing variants. */
export interface Vocabulary {
  readonly correspondents: readonly string[];
  readonly documentTypes: readonly string[];
  readonly tags: readonly string[];
}

export interface ExtractionInput {
  readonly text: string;
  readonly vocabulary: Vocabulary;
  /** `YYYY-MM-DD`. A document dated after this is misread, and two-digit years need it. */
  readonly today: string;
  readonly dateOrder: DateOrder;
  /** ISO 4217, for amounts that do not say. */
  readonly defaultCurrency: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `null` when the price of the model used is not known here. */
  readonly costUsd: number | null;
}

export interface Extraction {
  readonly fields: ExtractedFields;
  readonly usage: Usage;
  /** Which model or rule set produced it, e.g. `claude-haiku-4-5-20251001`, `heuristic-1`. */
  readonly model: string;
}

/**
 * Reads a document's details from its text (ADR 0010).
 *
 * Follows ADR 0005: a failure the caller can act on is a result, a crash is a throw.
 * Output is always normalised, so extractors can be compared field for field.
 */
export interface Extractor {
  readonly name: 'heuristic' | 'claude' | 'ollama';
  /** Bump on any change to rules or prompt: it re-extracts every document. */
  readonly version: number;
  extract(input: ExtractionInput): Promise<ApiResult<Extraction>>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
