export type { ExtractedFields, Field, Money } from './schema.ts';
export { FIELD_NAMES, SCHEMA_VERSION } from './schema.ts';
export type { DateOptions, DateOrder, FoundDate } from './normalise.ts';
export {
  findDates,
  matchVocabulary,
  normaliseName,
  parseDate,
  parseMoney,
  similarity,
} from './normalise.ts';
