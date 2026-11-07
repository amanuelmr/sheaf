/** The date on a document and its archive serial number: set, unique, filtered and sorted. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { AsnTaken, Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const [A, B, C] = [pdf('a'), pdf('b'), pdf('c')];
const [hashA, hashB, hashC] = [A, B, C].map(sha256Hex) as [string, string, string];
const NOW = 1_700_000_000_000;
const TOKEN = 'admin-token-for-asn';

let storage: Storage;

beforeEach(async () => {
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-asn-')),
  });
  await storage.put(hashA, A, NOW, 1);
  await storage.put(hashB, B, NOW + 1, 1);
  await storage.put(hashC, C, NOW + 2, 1);
});

const ids = async (filter: Parameters<Storage['find']>[1]) =>
  (await storage.find(null, filter, 20, 0)).hits.map((hit) => hit.sha256);

suite('created date and archive serial number', () => {
  it('are set by a patch, cleared by null, and recorded as a person’s choice', async () => {
    const record = await storage.patch(hashA, { created: '2025-11-30', asn: 7 }, NOW);
    expect(record).toMatchObject({ created: '2025-11-30', asn: 7 });
    const fields = await storage.fields(hashA);
    expect(fields.find((f) => f.name === 'date')).toMatchObject({
      value: '2025-11-30',
      source: 'user',
    });
    expect(await storage.patch(hashA, { created: null, asn: null }, NOW)).toMatchObject({
      created: null,
      asn: null,
    });
  });

  it('keeps each serial number on one document, and offers the next free one', async () => {
    expect(await storage.nextAsn()).toBe(1);
    await storage.patch(hashA, { asn: 7 }, NOW);
    await expect(storage.patch(hashB, { asn: 7 }, NOW)).rejects.toBeInstanceOf(AsnTaken);
    expect((await storage.record(hashB))?.asn).toBeNull();
    expect(await storage.patch(hashA, { asn: 7, title: 'again' }, NOW)).toMatchObject({ asn: 7 });
    expect(await storage.nextAsn()).toBe(8);
  });

  it('filters by created range and serial number, and sorts by either', async () => {
    await storage.patch(hashA, { created: '2025-12-31', asn: 3 }, NOW);
    await storage.patch(hashB, { created: '2026-01-15', asn: 1 }, NOW);
    expect(await ids({ createdFrom: '2026-01-01' })).toEqual([hashB]);
    expect(await ids({ createdTo: '2025-12-31' })).toEqual([hashA]);
    expect(await ids({ asn: 1 })).toEqual([hashB]);
    expect(await ids({ sort: 'created' })).toEqual([hashB, hashA, hashC]);
    expect(await ids({ sort: 'asn' })).toEqual([hashB, hashA, hashC]);
    const hit = (await storage.find(null, { asn: 3 }, 1, 0)).hits[0];
    expect(hit).toMatchObject({ created: '2025-12-31', asn: 3 });
  });

  it('answers 409 for a taken number, 400 for a bad patch, and serves the next number', async () => {
    const deps = { storage, token: TOKEN, now: () => NOW };
    const req = (method: string, path: string, body?: unknown): IngestRequest => ({
      method,
      path,
      query: '',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
    });
    expect((await handle(req('PATCH', paths.document(hashA), { asn: 5 }), deps)).status).toBe(200);
    const taken = await handle(req('PATCH', paths.document(hashB), { asn: 5 }), deps);
    expect(taken.status).toBe(409);
    const bad = await handle(req('PATCH', paths.document(hashB), { created: '31/12/2025' }), deps);
    expect(bad.status).toBe(400);
    expect((await handle(req('GET', paths.nextAsn()), deps)).json).toEqual({ asn: 6 });
  });
});
