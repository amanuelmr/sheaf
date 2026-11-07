/** Rewriting a PDF's pages: turn, drop, reorder, split, merge and collate. */
import { describe as suite, expect, it } from 'vitest';

import { labelled, names, turns } from './pdf-helpers';
import { collate, editPages, mergePdfs, pageCount, splitPdf } from '../src/pdf-edit';

suite('editing pages', () => {
  it('keeps, drops, reorders and turns pages in one go', async () => {
    const source = await labelled('a', 'b', 'c');
    const edited = await editPages(source, [{ page: 3 }, { page: 1, rotate: 90 }]);
    expect(await names(edited)).toEqual(['c', 'a']);
    expect(await turns(edited)).toEqual([0, 90]);
    expect(await turns(await editPages(edited, [{ page: 2, rotate: 270 }]))).toEqual([0]);
  });

  it('refuses a page that is not there, and an empty result', async () => {
    const source = await labelled('a');
    await expect(editPages(source, [{ page: 2 }])).rejects.toThrow('there is no page 2');
    await expect(editPages(source, [])).rejects.toThrow('at least one page');
  });

  it('splits into parts and merges back', async () => {
    const source = await labelled('a', 'b', 'c', 'd');
    const [first, second] = await splitPdf(source, [
      [1, 2],
      [3, 4],
    ]);
    expect(await names(first!)).toEqual(['a', 'b']);
    expect(await pageCount(second!)).toBe(2);
    expect(await names(await mergePdfs([second!, first!]))).toEqual(['c', 'd', 'a', 'b']);
  });

  it('collates fronts with reversed backs, and refuses passes that do not pair', async () => {
    const fronts = await labelled('1', '3', '5');
    const backs = await labelled('6', '4', '2');
    expect(await names(await collate(fronts, backs))).toEqual(['1', '2', '3', '4', '5', '6']);
    await expect(collate(fronts, await labelled('x'))).rejects.toThrow('fronts have 3 pages');
  });
});
