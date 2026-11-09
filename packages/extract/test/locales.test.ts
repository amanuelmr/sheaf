/** Dates and amounts as different places write them, read with each place's settings. */
import { describe as suite, expect, it } from 'vitest';
import { heuristicExtractor } from '../src/heuristic';
import { LOCALE_DOCUMENTS, LOCALE_TODAY } from '../eval/locales';

suite('reading documents from different places', () => {
  for (const doc of LOCALE_DOCUMENTS) {
    it(`reads the date, total and sender of ${doc.id}`, async () => {
      const outcome = await heuristicExtractor().extract({
        text: doc.text,
        vocabulary: { correspondents: [], documentTypes: [], tags: [] },
        today: LOCALE_TODAY,
        dateOrder: doc.dateOrder,
        defaultCurrency: doc.currency,
      });
      if (!outcome.ok) throw new Error('extraction failed');
      const { fields } = outcome.value;
      expect({
        date: fields.date?.value,
        total: fields.total?.value,
        correspondent: fields.correspondent?.value,
      }).toEqual(doc.expected);
    });
  }
});
