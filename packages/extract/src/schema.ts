/**
 * What extraction reads out of a document (ADR 0010). Versioned: a change here is a
 * change in what every extractor produces, so it re-processes every document.
 */
export const SCHEMA_VERSION = 1;

/** A value and how sure the extractor is of it, from 0 to 1. */
export interface Field<T> {
  readonly value: T;
  readonly confidence: number;
}

/** Money in integer minor units: 1234 with `EUR` is €12.34. Never a float. */
export interface Money {
  readonly minor: number;
  /** ISO 4217. */
  readonly currency: string;
}

export interface ExtractedFields {
  readonly title?: Field<string>;
  /** `YYYY-MM-DD`: when the document was issued, not when it was scanned. */
  readonly date?: Field<string>;
  readonly correspondent?: Field<string>;
  readonly documentType?: Field<string>;
  readonly total?: Field<Money>;
  readonly tags?: Field<readonly string[]>;
}

/** The field names, in the order a person reads them. */
export const FIELD_NAMES = [
  'title',
  'date',
  'correspondent',
  'documentType',
  'total',
  'tags',
] as const satisfies readonly (keyof ExtractedFields)[];
