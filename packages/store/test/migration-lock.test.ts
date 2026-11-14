/**
 * The capture log's schema on a phone that already ran a migration never runs it
 * again, so an edit would reach only fresh installs. Each migration's text is
 * locked here, since tests on a fresh database cannot see the difference.
 */
import { createHash } from 'node:crypto';
import { describe as suite, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/schema.ts';

/** Add a line for each new migration. Never change one: write a new migration instead. */
const LOCKED: readonly string[] = ['134d9258a55ab799'];

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

suite('the capture log’s migrations', () => {
  it('are never edited once written', () => {
    expect(MIGRATIONS.map(hash)).toEqual(LOCKED);
  });
});
