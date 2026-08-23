import { describe as suite, expect, it } from 'vitest';
import { resolveSuggestions } from '../src/suggestions';

const vocabulary = {
  correspondents: [
    { id: 3, name: 'Amazon' },
    { id: 9, name: 'Vattenfall' },
  ],
  documentTypes: [{ id: 7, name: 'Receipt' }],
  tags: [
    { id: 1, name: 'shopping' },
    { id: 2, name: 'electronics' },
  ],
};

suite('resolveSuggestions', () => {
  it('turns ids into the names the user actually recognises', () => {
    expect(
      resolveSuggestions(
        { correspondents: [3], document_types: [7], tags: [1, 2], dates: ['2026-08-22'] },
        vocabulary,
      ),
    ).toEqual({
      correspondent: 'Amazon',
      documentType: 'Receipt',
      tags: ['shopping', 'electronics'],
      date: '2026-08-22',
    });
  });

  it('drops an id it cannot name rather than showing a number', () => {
    // "Correspondent 47" is worse than no suggestion, and a stale cache is the
    // ordinary reason for it.
    expect(resolveSuggestions({ correspondents: [47], tags: [1, 99] }, vocabulary)).toEqual({
      tags: ['shopping'],
    });
  });

  it('takes the first suggestion Paperless ranked, not the last', () => {
    expect(resolveSuggestions({ correspondents: [9, 3] }, vocabulary).correspondent).toBe(
      'Vattenfall',
    );
  });

  it('returns nothing rather than empty fields when there is nothing to say', () => {
    expect(resolveSuggestions({}, vocabulary)).toEqual({});
    expect(resolveSuggestions({ tags: [] }, vocabulary)).toEqual({});
  });
});
