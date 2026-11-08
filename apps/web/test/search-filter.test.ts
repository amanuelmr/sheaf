/** Editing a filter on the Search page: emptiness, tidying, and the three-way tag toggle. */
import { describe as suite, expect, it } from 'vitest';
import { cycleTag, isEmptyFilter, tidy } from '../src/pages/Search';

suite('the search filter', () => {
  it('counts blank text and empty lists as asking for nothing', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ text: '  ', tags: [] })).toBe(true);
    expect(isEmptyFilter({ sort: 'oldest' })).toBe(false);
  });

  it('drops the parts that were cleared', () => {
    expect(tidy({ text: '', tags: [], receivedFrom: undefined, notTags: ['paid'] })).toEqual({
      notTags: ['paid'],
    });
  });

  it('cycles a tag from either way, to required, to excluded, and back', () => {
    const required = cycleTag({}, 'bills');
    expect(required).toEqual({ tags: ['bills'] });
    const excluded = cycleTag(required, 'bills');
    expect(excluded).toEqual({ notTags: ['bills'] });
    expect(cycleTag(excluded, 'bills')).toEqual({});
  });
});
