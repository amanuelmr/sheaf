/**
 * What a language model is asked to return, and the one place its answer is
 * checked. Claude and Ollama share both, so the same document asked of either is
 * judged the same way.
 *
 * Nothing a model says is trusted as typed: every value is checked for shape, and
 * dates and amounts are re-read through the normalisers. A model writing "Oct 5th"
 * produces the same `2026-10-05` the regex extractor would.
 */
import type { ExtractionInput } from './extractor.ts';
import { matchVocabulary, parseDate, parseMoney } from './normalise.ts';
import type { ExtractedFields } from './schema.ts';

const field = (value: object) => ({
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        value,
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['value', 'confidence'],
      additionalProperties: false,
    },
  ],
});

/** JSON Schema for the model's answer. Every field may be null: unknown beats invented. */
export const MODEL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: field({ type: 'string', description: 'A short title a person would file it under.' }),
    date: field({ type: 'string', description: 'Date the document was issued, YYYY-MM-DD.' }),
    correspondent: field({ type: 'string', description: 'Who sent or issued it.' }),
    document_type: field({ type: 'string', description: 'Receipt, Invoice, Bill, Letter, ...' }),
    total: field({
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'The total as printed, e.g. "1.234,56".' },
        currency: { type: 'string', description: 'ISO 4217 code, e.g. EUR.' },
      },
      required: ['amount', 'currency'],
      additionalProperties: false,
    }),
    tags: field({ type: 'array', items: { type: 'string' }, maxItems: 5 }),
  },
  required: ['title', 'date', 'correspondent', 'document_type', 'total', 'tags'],
  additionalProperties: false,
} as const;

/** The instructions both models get, followed by the archive's own names. */
export function systemPrompt(input: ExtractionInput): string {
  const list = (names: readonly string[]): string =>
    names.length === 0 ? '(none yet)' : names.slice(0, 200).join('; ');
  return [
    'You read the text of one scanned document and record its details.',
    'Use null for anything the text does not show. Never guess a value that is not there.',
    `Dates are YYYY-MM-DD. Read ambiguous numeric dates in ${input.dateOrder} order.`,
    `An amount with no currency shown is in ${input.defaultCurrency}.`,
    'The total is the final amount paid or due, not a subtotal or tax line.',
    'When the correspondent or type is the same as a name below, use that exact name.',
    'Confidence is your probability that the value is exactly right.',
    '',
    `Known correspondents: ${list(input.vocabulary.correspondents)}`,
    `Known document types: ${list(input.vocabulary.documentTypes)}`,
    `Known tags: ${list(input.vocabulary.tags)}`,
  ].join('\n');
}

/**
 * Long documents keep their start and end, where the sender, date and total
 * usually are, and lose the middle.
 */
export function documentMessage(text: string, maxChars = 12_000): string {
  const body =
    text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars * 0.7)}\n[…]\n${text.slice(text.length - maxChars * 0.3)}`;
  return `<document>\n${body}\n</document>`;
}

/** The model's answer as fields, or null if it is not the shape that was asked for. */
export function toFields(raw: unknown, input: ExtractionInput): ExtractedFields | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  const fields: {
    -readonly [K in keyof ExtractedFields]: ExtractedFields[K];
  } = {};

  for (const key of ['title', 'date', 'correspondent', 'document_type', 'total', 'tags']) {
    const entry = answer[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { value, confidence } = entry as { value?: unknown; confidence?: unknown };
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null;

    switch (key) {
      case 'title':
      case 'correspondent':
      case 'document_type': {
        if (typeof value !== 'string') return null;
        const text = value.trim().slice(0, 200);
        if (text === '') break;
        if (key === 'title') fields.title = { value: text, confidence };
        if (key === 'correspondent') {
          const known = matchVocabulary(text, input.vocabulary.correspondents);
          fields.correspondent = { value: known ?? text, confidence };
        }
        if (key === 'document_type') {
          const known = matchVocabulary(text, input.vocabulary.documentTypes);
          fields.documentType = { value: known ?? text, confidence };
        }
        break;
      }
      case 'date': {
        if (typeof value !== 'string') return null;
        const iso = parseDate(value, { order: input.dateOrder, today: input.today });
        // A date the normalisers cannot read is dropped, not passed on as text.
        if (iso !== null) fields.date = { value: iso, confidence };
        break;
      }
      case 'total': {
        if (typeof value !== 'object' || value === null) return null;
        const { amount, currency } = value as { amount?: unknown; currency?: unknown };
        if (typeof amount !== 'string' || typeof currency !== 'string') return null;
        const money = parseMoney(`${currency} ${amount}`, input.defaultCurrency);
        if (money !== null) fields.total = { value: money, confidence };
        break;
      }
      case 'tags': {
        if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) return null;
        const tags = value
          .map((tag) => matchVocabulary(tag, input.vocabulary.tags) ?? tag.trim())
          .filter((tag) => tag !== '')
          .slice(0, 5);
        if (tags.length > 0) fields.tags = { value: [...new Set(tags)], confidence };
        break;
      }
    }
  }
  return fields;
}
