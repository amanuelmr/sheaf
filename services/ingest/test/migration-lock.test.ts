/**
 * A migration that has run somewhere is history: a server that already applied it
 * never runs it again, so an edit reaches only fresh installs and the two drift
 * apart. Tests build a fresh database every time and cannot see that, so each
 * migration's text is locked here instead.
 */
import { createHash } from 'node:crypto';
import { describe as suite, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations.ts';

/** Add a line for each new migration. Never change one: write a new migration instead. */
const LOCKED: Readonly<Record<number, string>> = {
  1: 'c24243b16a000ebf',
  2: '7ed727f30c927fe6',
  3: 'c2c2006af408cb3d',
  4: '19baa9c6f9706e97',
  5: 'dc4491c1f50ebd60',
  6: '009b2f6a0943792f',
  7: '9e93154a60fa0fdd',
  8: '2bf08accab3a7f01',
  9: 'f0552732088f1551',
  10: '36e4607875d6b557',
  11: '4697df7dbfaf299d',
  12: 'dbbc2a59a6991bdb',
  13: 'ef250c919f4b6bb8',
  14: 'ddd37d152507904b',
  15: 'cd696655c642369a',
  16: '2562fe28baf03b94',
  17: '0c7f864a5ce5f269',
  18: '57bd1d2650eb9b4d',
  19: '74fc08a8198c0c2c',
  20: '41137dad92b2f955',
  21: 'c1f88b9f1768718e',
  22: 'fedf92bf9c3ba5b6',
  23: '621fec85516e4fbd',
  24: 'bf1468e9ffb2e686',
  25: '22f51f1fc8424623',
  26: '927848a4659099b5',
  27: 'd2d0671ba462e5e2',
  28: '751282d7b39aafbf',
  29: '956399a51b6186ed',
  30: '29f90f1afad8d337',
};

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

suite('the server’s migrations', () => {
  it('are never edited once written', () => {
    const now = Object.fromEntries(MIGRATIONS.map((m) => [m.id, hash([m.name, m.statements])]));
    expect(now).toEqual(LOCKED);
  });
});
