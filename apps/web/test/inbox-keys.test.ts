/** Inbox shortcuts: single keys on the list, never a browser shortcut. */
import { describe as suite, expect, it } from 'vitest';
import { inboxAction } from '../src/pages/Inbox';

const press = (
  key: string,
  held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {},
) => inboxAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...held });

suite('inbox shortcuts', () => {
  it('move with j and k or the arrows, accept with a, edit with e', () => {
    expect(['j', 'ArrowDown', 'k', 'ArrowUp', 'a', 'e'].map((key) => press(key))).toEqual([
      'down',
      'down',
      'up',
      'up',
      'accept',
      'edit',
    ]);
  });

  it('leave Cmd+A, Ctrl+A and Alt+E to the browser', () => {
    expect(press('a', { metaKey: true })).toBeNull();
    expect(press('a', { ctrlKey: true })).toBeNull();
    expect(press('e', { altKey: true })).toBeNull();
  });

  it('ignore every other key', () => {
    expect(press('x')).toBeNull();
    expect(press('Enter')).toBeNull();
  });
});
