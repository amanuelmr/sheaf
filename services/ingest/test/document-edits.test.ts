/** Editing pages keeps the document under a new file; split and merge make new documents. */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { parsePageList, paths } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { DocumentEdits } from '../src/document-edits';
import { handle, type IngestRequest } from '../src/router';
import { ShareLinks } from '../src/share-links';
import { Storage, sha256Hex } from '../src/storage';
import { labelled, names, turns } from './pdf-helpers';

const TOKEN = 'admin-token-for-edits';
const NOW = 1_700_000_000_000;

let driver: SqlDriver;
let storage: Storage;
let deps: Parameters<typeof handle>[1];
let A: Uint8Array;
let hashA: string;
let B: Uint8Array;
let hashB: string;

const req = (method: string, path: string, body?: unknown): IngestRequest => ({
  method,
  path,
  query: '',
  headers: { authorization: `Bearer ${TOKEN}` },
  body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-ed-')) });
  deps = {
    storage,
    token: TOKEN,
    now: () => NOW,
    edits: new DocumentEdits(storage, driver),
    shareLinks: new ShareLinks(driver, storage),
  };
  A = await labelled('a1', 'a2', 'a3');
  hashA = sha256Hex(A);
  B = await labelled('b1');
  hashB = sha256Hex(B);
  await storage.put(hashA, A, NOW, 3);
  await storage.put(hashB, B, NOW, 1);
  await storage.patch(hashA, { title: 'Lease', tags: ['home'], asn: 4 }, NOW);
});

suite('editing pages', () => {
  it('moves the document to the new file with everything it had, keeping the old as a version', async () => {
    await storage.addNote(hashA, 'signed copy', null, NOW);
    const fields = new CustomFields(driver, storage);
    const link = await fields.create({ name: 'Related', type: 'documentLink' }, NOW);
    if (!link.ok) throw new Error('no field');
    await fields.setValues(hashB, [{ field: link.value.id, value: [hashA] }], NOW);
    const archiveId = await storage.archiveIdFor(hashA);

    const response = await handle(
      req('POST', paths.documentPages(hashA), { pages: [{ page: 3 }, { page: 1, rotate: 90 }] }),
      deps,
    );
    expect(response.status).toBe(200);
    const edited = response.json as {
      sha256: string;
      title: string;
      asn: number;
      pageCount: number;
    };
    expect(edited).toMatchObject({ title: 'Lease', asn: 4, pageCount: 2 });
    const bytes = storage.bytes(edited.sha256)!;
    expect(await names(bytes)).toEqual(['a3', 'a1']);
    expect(await turns(bytes)).toEqual([0, 90]);

    expect(await storage.has(hashA)).toBe(false);
    expect((await storage.notes(edited.sha256)).map((n) => n.text)).toEqual(['signed copy']);
    expect((await fields.valuesOf(hashB))[0]?.value).toEqual([edited.sha256]);
    expect(await storage.archiveIdFor(edited.sha256)).toBe(archiveId);

    const versions = (await handle(req('GET', paths.documentVersions(edited.sha256)), deps))
      .json as {
      versions: { sha256: string; pageCount: number }[];
    };
    expect(versions.versions).toEqual([expect.objectContaining({ sha256: hashA, pageCount: 3 })]);
    const old = await handle(req('GET', paths.documentVersion(edited.sha256, hashA)), deps);
    expect(old.bytes).toEqual(A);
  });

  it('restores an earlier version, keeping the edit as a version in turn', async () => {
    const edited = (
      await handle(req('POST', paths.documentPages(hashA), { pages: [{ page: 2 }] }), deps)
    ).json as { sha256: string };
    const restored = await handle(req('POST', paths.restoreVersion(edited.sha256, hashA)), deps);
    expect(restored.json).toMatchObject({ sha256: hashA, title: 'Lease', pageCount: 3 });
    expect((await storage.versions(hashA)).map((v) => v.sha256)).toEqual([edited.sha256]);
  });

  it('refuses a page the document does not have', async () => {
    const response = await handle(
      req('POST', paths.documentPages(hashA), { pages: [{ page: 9 }] }),
      deps,
    );
    expect(response.status).toBe(400);
    expect((response.json as { detail: string }).detail).toMatch(/no page 9/);
  });

  it('deletes the earlier files with the document', async () => {
    const edited = (
      await handle(req('POST', paths.documentPages(hashA), { pages: [{ page: 1 }] }), deps)
    ).json as { sha256: string };
    await storage.trash(edited.sha256, NOW);
    await storage.purge(edited.sha256);
    expect(existsSync(storage.pathFor(hashA))).toBe(false);
    expect(existsSync(storage.pathFor(edited.sha256))).toBe(false);
  });
});

suite('splitting and merging', () => {
  it('splits into documents filed like the original, which goes to the trash', async () => {
    const response = await handle(
      req('POST', paths.documentSplit(hashA), { parts: [[1], [2, 3]] }),
      deps,
    );
    expect(response.status).toBe(201);
    const { documents } = response.json as { documents: string[] };
    expect(await names(storage.bytes(documents[1]!)!)).toEqual(['a2', 'a3']);
    expect(await storage.record(documents[0]!)).toMatchObject({
      title: 'Lease (1 of 2)',
      tags: ['home'],
      asn: null,
    });
    expect((await storage.record(hashA))?.trashedAt).toBe(NOW);
  });

  it('merges documents in the order given, keeping the originals when asked', async () => {
    const response = await handle(
      req('POST', paths.mergeDocuments(), { documents: [hashB, hashA], keepOriginals: true }),
      deps,
    );
    expect(response.status).toBe(201);
    const merged = response.json as { sha256: string; tags: string[] };
    expect(await names(storage.bytes(merged.sha256)!)).toEqual(['b1', 'a1', 'a2', 'a3']);
    expect(merged.tags).toEqual(['home']);
    expect((await storage.record(hashB))?.trashedAt).toBeUndefined();
  });

  it('reads page lists the way people type them', () => {
    expect(parsePageList('1-3, 5')).toEqual([1, 2, 3, 5]);
    expect(parsePageList('3-1')).toBeNull();
    expect(parsePageList('')).toBeNull();
    expect(parsePageList('a')).toBeNull();
  });
});
