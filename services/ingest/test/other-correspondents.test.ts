/** Documents from, or between, more than one correspondent. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { documentPatchProblem } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Labels } from '../src/labels';
import { Storage, sha256Hex } from '../src/storage';

const NOW = 1_700_000_000_000;

async function setup() {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-others-')),
  });
  const add = async (text: string) => {
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`));
    await storage.put(sha256Hex(bytes), bytes, NOW, 1);
    return sha256Hex(bytes);
  };
  return { storage, labels: new Labels(driver, storage), add };
}

suite('more than one correspondent', () => {
  it('keeps the others once each, without the main one', async () => {
    const { storage, add } = await setup();
    const lease = await add('lease');
    const record = await storage.patch(lease, {
      correspondent: 'Ann',
      otherCorrespondents: [' Bob ', 'Ann', 'Bob', 'Acme Lettings', ''],
    });
    expect(record?.correspondent).toBe('Ann');
    expect(record?.otherCorrespondents).toEqual(['Bob', 'Acme Lettings']);
    expect(documentPatchProblem({ otherCorrespondents: 'Bob' })).toMatch(/list of names/);
  });

  it('is found by filtering or searching for any of them, and counted for each', async () => {
    const { storage, labels, add } = await setup();
    const lease = await add('lease');
    const bill = await add('bill');
    await storage.patch(lease, { correspondent: 'Ann', otherCorrespondents: ['Acme Lettings'] });
    await storage.patch(bill, { correspondent: 'Acme Lettings' });

    const byAcme = await storage.find(null, { correspondents: ['Acme Lettings'] }, 10, 0);
    expect(byAcme.hits.map((h) => h.sha256).sort()).toEqual([lease, bill].sort());
    const searched = await storage.find('"acme"', {}, 10, 0);
    expect(searched.hits.map((h) => h.sha256).sort()).toEqual([lease, bill].sort());
    const acme = (await labels.list('correspondent')).find((l) => l.name === 'Acme Lettings');
    expect(acme?.documents).toBe(2);
  });

  it('follows a rename, and drops a correspondent that is removed', async () => {
    const { storage, labels, add } = await setup();
    const lease = await add('lease');
    await storage.patch(lease, { correspondent: 'Ann', otherCorrespondents: ['Bob', 'Acme'] });
    const byName = async (name: string) =>
      (await labels.list('correspondent')).find((l) => l.name === name)!;

    await labels.update('correspondent', (await byName('Acme')).id, { name: 'Acme Lettings' });
    expect((await storage.record(lease))?.otherCorrespondents).toEqual(['Bob', 'Acme Lettings']);
    await labels.remove('correspondent', (await byName('Bob')).id);
    expect((await storage.record(lease))?.otherCorrespondents).toEqual(['Acme Lettings']);
  });
});
