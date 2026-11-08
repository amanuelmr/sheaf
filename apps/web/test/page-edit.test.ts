/** The page editor: turning, moving and removing pages, and reading split parts. */
import { describe as suite, expect, it } from 'vitest';
import { initialRows, move, pagesToSend, parseParts, turn } from '../src/page-edit';

suite('the page editor', () => {
  it('sends nothing until something changes', () => {
    expect(pagesToSend(initialRows(3))).toBeNull();
  });

  it('turns, moves and removes pages', () => {
    let rows = initialRows(3);
    rows = turn(rows, 0, 90);
    rows = turn(rows, 0, 270);
    rows = turn(rows, 2, 270);
    rows = move(rows, 2, -1);
    rows = rows.map((row) => (row.page === 1 ? { ...row, removed: true } : row));
    expect(pagesToSend(rows)).toEqual([{ page: 3, rotate: 270 }, { page: 2 }]);
    expect(move(rows, 0, -1)).toEqual(rows);
  });

  it('reads parts separated by semicolons, within the page count', () => {
    expect(parseParts('1-2; 3', 3)).toEqual([[1, 2], [3]]);
    expect(parseParts('1-4', 3)).toBeNull();
    expect(parseParts(' ; ', 3)).toBeNull();
  });
});
