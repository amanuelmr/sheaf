/** Exporting everything a person put in, and importing it into another server. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { exportTo, importFrom, MANIFEST, type BackupParts, type Manifest } from '../src/backup';
import { CustomFields } from '../src/custom-fields';
import { Labels } from '../src/labels';
import { Storage, sha256Hex } from '../src/storage';
import { SavedViews } from '../src/views';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const NOW = Date.parse('2026-03-04T10:00:00Z');

async function server(): Promise<BackupParts> {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-bu-')),
  });
  return {
    driver,
    storage,
    labels: new Labels(driver, storage),
    fields: new CustomFields(driver, storage),
    views: new SavedViews(driver),
  };
}

let from: BackupParts;
let dir: string;

beforeEach(async () => {
  from = await server();
  dir = mkdtempSync(join(tmpdir(), 'sheaf-export-'));
  const { storage, labels, fields, views } = from;
  await storage.put(hashA, A, NOW, 1);
  await storage.put(hashB, B, NOW + 1, 2);
  await storage.put(hashC, C, NOW + 2, 1);
  await storage.patch(hashA, {
    title: 'March bill',
    correspondent: 'City Power',
    tags: ['bills'],
    created: '2026-02-28',
    asn: 3,
  });
  await storage.patch(hashB, {
    title: 'March bill',
    correspondent: 'City Power',
    created: '2026-02-28',
  });
  await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: 'kilowatt hours' }, NOW);
  await storage.addNote(hashA, 'paid by card', null, NOW + 5);
  await storage.trash(hashC, NOW);
  const tags = await labels.list('tag');
  await labels.update('tag', tags[0]!.id, {
    colour: '#aa0000',
    matching: { algorithm: 'any', pattern: 'invoice', caseSensitive: false },
  });
  const ref = await fields.create({ name: 'Ref', type: 'text' }, NOW);
  const link = await fields.create({ name: 'Related', type: 'documentLink' }, NOW);
  if (!ref.ok || !link.ok) throw new Error('no fields');
  await fields.setValues(
    hashA,
    [
      { field: ref.value.id, value: 'R-1' },
      { field: link.value.id, value: [hashB] },
    ],
    NOW,
  );
  await views.create({ name: 'Bills', filter: { tags: ['bills'] }, onDashboard: true }, NOW);
});

suite('export', () => {
  it('writes each document by the format, without the trash, and a manifest of everything', async () => {
    const report = await exportTo(dir, from, '{{created_year}}/{{correspondent}}/{{title}}', NOW);
    expect(report).toEqual({ documents: 2, withoutFile: 0 });
    expect(readFileSync(join(dir, '2026/City Power/March bill.pdf'))).toEqual(Buffer.from(A));
    expect(readFileSync(join(dir, '2026/City Power/March bill (2).pdf'))).toEqual(Buffer.from(B));

    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest;
    expect(manifest.documents.map((d) => d.sha256)).toEqual([hashA, hashB]);
    expect(manifest.documents[0]).toMatchObject({
      asn: 3,
      texts: [{ text: 'kilowatt hours' }],
      notes: [{ text: 'paid by card' }],
      customFields: [
        { field: 'Ref', value: 'R-1' },
        { field: 'Related', value: [hashB] },
      ],
    });
    expect(manifest.labels.find((l) => l.name === 'bills')).toMatchObject({
      colour: '#aa0000',
      matching: { algorithm: 'any' },
    });
    expect(manifest.views).toEqual([
      { name: 'Bills', filter: { tags: ['bills'] }, onDashboard: true, position: 1 },
    ]);
  });
});

suite('import', () => {
  it('brings everything back on another server, and running it twice changes nothing', async () => {
    await exportTo(dir, from, '{{title}}', NOW);
    const to = await server();
    expect(await importFrom(dir, to, NOW)).toEqual({ imported: 2, alreadyHere: 0, problems: [] });

    expect(await to.storage.record(hashA)).toMatchObject({
      title: 'March bill',
      correspondent: 'City Power',
      tags: ['bills'],
      created: '2026-02-28',
      asn: 3,
      receivedAt: NOW,
    });
    expect((await to.storage.texts(hashA)).map((t) => t.text)).toEqual(['kilowatt hours']);
    expect((await to.fields.valuesOf(hashA)).map((v) => [v.name, v.value])).toEqual([
      ['Ref', 'R-1'],
      ['Related', [hashB]],
    ]);
    expect((await to.fields.valuesOf(hashB)).map((v) => v.value)).toEqual([[hashA]]);
    expect((await to.labels.list('tag'))[0]).toMatchObject({ name: 'bills', colour: '#aa0000' });
    expect((await to.views.list()).map((v) => v.name)).toEqual(['Bills']);

    expect(await importFrom(dir, to, NOW)).toEqual({ imported: 0, alreadyHere: 2, problems: [] });
    expect((await to.storage.notes(hashA)).length).toBe(1);
  });

  it('refuses a file that does not match its hash, and reports a serial number in use', async () => {
    await exportTo(dir, from, '{{sha256}}', NOW);
    writeFileSync(join(dir, `${hashB}.pdf`), 'tampered');
    const to = await server();
    await to.storage.put(hashC, C, NOW, 1);
    await to.storage.patch(hashC, { asn: 3 });

    const report = await importFrom(dir, to, NOW);
    expect(report.imported).toBe(1);
    expect(report.problems).toEqual([
      `${hashA}: archive serial number 3 belongs to another document; imported without it`,
      `${hashB}: ${hashB}.pdf does not match its hash`,
      `${hashA}: custom fields not set (no document ${hashB.slice(0, 8)}…)`,
    ]);
    expect((await to.storage.record(hashA))?.asn).toBeNull();
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });
});
