/**
 * Labels: correspondents, document types and tags managed in one place, with
 * every rename, merge and delete reaching each document that carries them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import type { Label, LabelKind } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Labels } from '../src/labels';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const NOW = 1_700_000_000_000;

let driver: SqlDriver;
let storage: Storage;
let labels: Labels;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-lb-')) });
  labels = new Labels(driver, storage);
  for (const [hash, bytes] of [
    [hashA, A],
    [hashB, B],
    [hashC, C],
  ] as const) {
    await storage.put(hash, bytes, NOW, 1);
  }
  await storage.patch(hashA, { correspondent: 'ACME', tags: ['bills', 'home'] }, NOW);
  await storage.patch(hashB, { correspondent: 'ACME', documentType: 'Invoice', tags: ['bills'] });
  await storage.patch(hashC, { correspondent: 'Acme Corp', tags: ['home', 'tax'] }, NOW);
});

async function byName(kind: LabelKind, name: string): Promise<Label> {
  const found = (await labels.list(kind)).find((label) => label.name === name);
  if (found === undefined) throw new Error(`no ${kind} named ${name}`);
  return found;
}

const find = async (q: string): Promise<string[]> =>
  (await storage.search(toMatch(q)!, 20, 0)).hits.map((hit) => hit.sha256).sort();

suite('listing', () => {
  it('lists each kind by name, with how many documents carry each', async () => {
    expect((await labels.list('correspondent')).map((l) => [l.name, l.documents])).toEqual([
      ['ACME', 2],
      ['Acme Corp', 1],
    ]);
    expect((await labels.list('tag')).map((l) => [l.name, l.documents])).toEqual([
      ['bills', 2],
      ['home', 2],
      ['tax', 1],
    ]);
    expect((await labels.list('documentType')).map((l) => l.name)).toEqual(['Invoice']);
  });

  it('leaves trashed documents out of the counts', async () => {
    await storage.trash(hashA, NOW);
    expect((await byName('tag', 'home')).documents).toBe(1);
    expect((await byName('correspondent', 'ACME')).documents).toBe(1);
  });
});

suite('creating', () => {
  it('adds a label no document carries yet, with a colour for a tag', async () => {
    const made = await labels.create('tag', { name: 'travel', colour: '#336699' });
    expect(made.ok && made.value).toMatchObject({
      name: 'travel',
      documents: 0,
      colour: '#336699',
    });
  });

  it('refuses a name already taken, and a colour on anything but a tag', async () => {
    expect(await labels.create('tag', { name: 'bills' })).toMatchObject({ kind: 'conflict' });
    expect(await labels.create('correspondent', { name: 'Bank', colour: '#000000' })).toMatchObject(
      { kind: 'invalid' },
    );
  });
});

suite('renaming', () => {
  it('renames a tag on every document, its field record and search', async () => {
    const bills = await byName('tag', 'bills');
    const renamed = await labels.update('tag', bills.id, { name: 'utilities' });
    expect(renamed.ok && renamed.value).toMatchObject({ id: bills.id, name: 'utilities' });

    expect((await storage.record(hashA))?.tags).toEqual(['utilities', 'home']);
    expect((await storage.record(hashB))?.tags).toEqual(['utilities']);
    const field = (await storage.fields(hashA)).find((f) => f.name === 'tags');
    expect(field).toMatchObject({ value: ['utilities', 'home'], source: 'user' });
    expect(await find('utilities')).toEqual([hashA, hashB].sort());
    expect(await find('bills')).toEqual([]);
  });

  it('renames a correspondent everywhere it is written', async () => {
    const acme = await byName('correspondent', 'ACME');
    await labels.update('correspondent', acme.id, { name: 'Acme Inc' });
    expect((await storage.record(hashA))?.correspondent).toBe('Acme Inc');
    expect((await storage.record(hashB))?.correspondent).toBe('Acme Inc');
    expect((await storage.record(hashC))?.correspondent).toBe('Acme Corp');
    const field = (await storage.fields(hashB)).find((f) => f.name === 'correspondent');
    expect(field?.value).toBe('Acme Inc');
  });

  it('rewrites suggestions nobody acted on yet, so accepting one cannot bring the old name back', async () => {
    await driver.run('UPDATE documents SET suggestions_json = ? WHERE sha256 = ?', [
      JSON.stringify({ correspondent: 'ACME', tags: ['tax', 'bills'] }),
      hashC,
    ]);
    await labels.update('correspondent', (await byName('correspondent', 'ACME')).id, {
      name: 'Acme Inc',
    });
    await labels.update('tag', (await byName('tag', 'bills')).id, { name: 'utilities' });
    expect((await storage.record(hashC))?.suggestions).toEqual({
      correspondent: 'Acme Inc',
      tags: ['tax', 'utilities'],
    });
  });

  it('refuses a name another label has, pointing at merge', async () => {
    const home = await byName('tag', 'home');
    const refused = await labels.update('tag', home.id, { name: 'bills' });
    expect(refused.ok === false && refused.kind === 'conflict' && refused.message).toMatch(/merge/);
    expect((await storage.record(hashA))?.tags).toEqual(['bills', 'home']);
  });

  it('changes only the case of a name', async () => {
    const tax = await byName('tag', 'tax');
    expect((await labels.update('tag', tax.id, { name: 'Tax' })).ok).toBe(true);
    expect((await storage.record(hashC))?.tags).toEqual(['home', 'Tax']);
  });

  it('sets and clears a tag colour, and only a tag colour', async () => {
    const home = await byName('tag', 'home');
    await labels.update('tag', home.id, { colour: '#ff0000' });
    expect((await byName('tag', 'home')).colour).toBe('#ff0000');
    await labels.update('tag', home.id, { colour: null });
    expect((await byName('tag', 'home')).colour).toBeNull();
    const acme = await byName('correspondent', 'ACME');
    expect(await labels.update('correspondent', acme.id, { colour: '#ff0000' })).toMatchObject({
      kind: 'invalid',
    });
  });

  it('answers not found for a label of another kind', async () => {
    const acme = await byName('correspondent', 'ACME');
    expect(await labels.update('tag', acme.id, { name: 'x' })).toMatchObject({ kind: 'not_found' });
  });
});

suite('merging', () => {
  it('moves every document to the other label, once each, and forgets the first', async () => {
    const home = await byName('tag', 'home');
    const bills = await byName('tag', 'bills');
    const merged = await labels.merge('tag', home.id, bills.id);
    expect(merged.ok && merged.value).toMatchObject({ name: 'bills', documents: 3 });

    expect((await storage.record(hashA))?.tags).toEqual(['bills']);
    expect((await storage.record(hashC))?.tags).toEqual(['bills', 'tax']);
    expect((await labels.list('tag')).map((l) => l.name)).toEqual(['bills', 'tax']);
    expect(await find('home')).toEqual([]);
  });

  it('folds one correspondent into another', async () => {
    const corp = await byName('correspondent', 'Acme Corp');
    const acme = await byName('correspondent', 'ACME');
    await labels.merge('correspondent', corp.id, acme.id);
    expect((await storage.record(hashC))?.correspondent).toBe('ACME');
    expect((await byName('correspondent', 'ACME')).documents).toBe(3);
  });

  it('refuses itself, and a label that is not there', async () => {
    const home = await byName('tag', 'home');
    expect(await labels.merge('tag', home.id, home.id)).toMatchObject({ kind: 'invalid' });
    expect(await labels.merge('tag', home.id, 9999)).toMatchObject({ kind: 'invalid' });
    expect(await labels.merge('tag', 9999, home.id)).toMatchObject({ kind: 'not_found' });
  });
});

suite('deleting', () => {
  it('takes a tag off every document and out of search', async () => {
    const home = await byName('tag', 'home');
    expect(await labels.remove('tag', home.id)).toBe(true);
    expect((await storage.record(hashA))?.tags).toEqual(['bills']);
    expect((await storage.record(hashC))?.tags).toEqual(['tax']);
    expect(await find('home')).toEqual([]);
    expect(await labels.remove('tag', home.id)).toBe(false);
  });

  it('clears a document type, and drops it from suggestions', async () => {
    await driver.run('UPDATE documents SET suggestions_json = ? WHERE sha256 = ?', [
      JSON.stringify({ documentType: 'Invoice', title: 'March' }),
      hashA,
    ]);
    const invoice = await byName('documentType', 'Invoice');
    await labels.remove('documentType', invoice.id);
    expect((await storage.record(hashB))?.documentType).toBeNull();
    expect((await storage.record(hashA))?.suggestions).toEqual({ title: 'March' });
    const field = (await storage.fields(hashB)).find((f) => f.name === 'documentType');
    expect(field?.value).toBeNull();
  });
});
