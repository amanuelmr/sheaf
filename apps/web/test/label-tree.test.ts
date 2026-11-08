/** Tags listed under their parents. */
import { describe as suite, expect, it } from 'vitest';
import type { Label } from '@sheaf/protocol';
import { tree } from '../src/pages/Labels';

const tag = (id: number, name: string, parent: number | null): Label => ({
  id,
  kind: 'tag',
  name,
  documents: 0,
  colour: null,
  matching: { algorithm: 'none', pattern: '', caseSensitive: false },
  inbox: false,
  parent,
});

suite('the tag tree', () => {
  it('puts each tag under its parent, keeping name order among siblings', () => {
    const labels = [
      tag(1, 'bills', null),
      tag(2, 'car', 3),
      tag(3, 'home', null),
      tag(4, 'garden', 3),
    ];
    expect(tree(labels).map(({ label, depth }) => `${'-'.repeat(depth)}${label.name}`)).toEqual([
      'bills',
      'home',
      '-car',
      '-garden',
    ]);
  });

  it('shows a tag whose parent is missing at the top', () => {
    expect(tree([tag(5, 'orphan', 99)]).map((row) => row.depth)).toEqual([0]);
  });
});
