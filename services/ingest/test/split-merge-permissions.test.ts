/** Splitting and merging never show a private document to anyone new. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths, type DocumentPermissions } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { DocumentEdits, mergedPermissions } from '../src/document-edits';
import { handle, type IngestRequest } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';
import { Users } from '../src/users';
import { labelled } from './pdf-helpers';

const TOKEN = 'admin-token-for-split-merge';
const NOW = 1_700_000_000_000;
const PASSWORD = 'a long enough password';

let storage: Storage;
let edits: DocumentEdits;
let deps: Parameters<typeof handle>[1];
let tokens: Record<string, string>;
let ids: Record<string, number>;

const req = (method: string, path: string, token: string, body?: unknown): IngestRequest => ({
  method,
  path,
  query: '',
  headers: { authorization: `Bearer ${token}` },
  body:
    body instanceof Uint8Array
      ? body
      : new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

/** Uploads a PDF as `who`, and returns its sha256. */
async function upload(who: string, ...pages: string[]): Promise<string> {
  const bytes = await labelled(...pages);
  const sha256 = sha256Hex(bytes);
  const token = who === 'admin' ? TOKEN : tokens[who]!;
  const response = await handle(req('PUT', paths.document(sha256), token, bytes), deps);
  expect(response.status).toBeLessThan(300);
  return sha256;
}

async function share(who: string, sha256: string, permissions: DocumentPermissions) {
  const response = await handle(
    req('PUT', paths.documentPermissions(sha256), tokens[who]!, permissions),
    deps,
  );
  expect(response.status).toBe(200);
}

const sees = async (who: string, sha256: string) =>
  (await handle(req('GET', paths.document(sha256), tokens[who]!), deps)).status === 200;

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-sm-')) });
  const users = new Users(driver);
  edits = new DocumentEdits(storage, driver);
  deps = { storage, token: TOKEN, now: () => NOW, users, edits };
  tokens = {};
  ids = {};
  for (const name of ['ann', 'bob', 'cat']) {
    const made = await users.create({ username: name, password: PASSWORD, role: 'editor' }, NOW);
    if (made === 'taken') throw new Error(name);
    ids[name] = made.id;
    const signed = await users.signIn(name, PASSWORD, NOW);
    if (!signed.ok) throw new Error(name);
    tokens[name] = signed.token;
  }
});

suite('splitting', () => {
  it('gives every part the owner and sharing of the document it came from', async () => {
    const lease = await upload('ann', 'p1', 'p2');
    await share('ann', lease, {
      owner: ids['ann']!,
      grants: [{ user: ids['bob']!, level: 'view' }],
    });

    const response = await handle(
      req('POST', paths.documentSplit(lease), tokens['ann']!, { parts: [[1], [2]] }),
      deps,
    );
    expect(response.status).toBe(201);
    const { documents } = response.json as { documents: string[] };
    for (const part of documents) {
      expect(await storage.permissions(part)).toEqual({
        owner: ids['ann'],
        grants: [{ user: ids['bob'], level: 'view' }],
      });
      expect(await sees('bob', part)).toBe(true);
      expect(await sees('cat', part)).toBe(false);
    }
  });

  it('keeps the parts of a bundle split at a separator sheet private too', async () => {
    const bundle = await upload('ann', 'p1', 'p2');
    const parts = await edits.splitArrival(bundle, [[1], [2]], NOW);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(await storage.permissions(part)).toEqual({ owner: ids['ann'], grants: [] });
      expect(await sees('cat', part)).toBe(false);
    }
  });
});

suite('merging', () => {
  it('keeps the owner the documents share, with only the sharing they all had', async () => {
    const one = await upload('ann', 'one');
    const two = await upload('ann', 'two');
    await share('ann', one, {
      owner: ids['ann']!,
      grants: [
        { user: ids['bob']!, level: 'change' },
        { user: ids['cat']!, level: 'view' },
      ],
    });
    await share('ann', two, { owner: ids['ann']!, grants: [{ user: ids['bob']!, level: 'view' }] });

    const response = await handle(
      req('POST', paths.mergeDocuments(), tokens['ann']!, { documents: [one, two] }),
      deps,
    );
    expect(response.status).toBe(201);
    const merged = (response.json as { sha256: string }).sha256;
    expect(await storage.permissions(merged)).toEqual({
      owner: ids['ann'],
      grants: [{ user: ids['bob'], level: 'view' }],
    });
    expect(await sees('cat', merged)).toBe(false);
  });

  it('makes documents with different owners the merger’s alone', async () => {
    const mine = await upload('ann', 'mine');
    const everyones = await upload('admin', 'everyone');

    const response = await handle(
      req('POST', paths.mergeDocuments(), tokens['ann']!, { documents: [mine, everyones] }),
      deps,
    );
    expect(response.status).toBe(201);
    const merged = (response.json as { sha256: string }).sha256;
    expect(await storage.permissions(merged)).toEqual({ owner: ids['ann'], grants: [] });
    expect(await sees('bob', merged)).toBe(false);
  });

  it('refuses the admin token merging different people’s documents, and changes nothing', async () => {
    const anns = await upload('ann', 'ann');
    const bobs = await upload('bob', 'bob');

    const response = await handle(
      req('POST', paths.mergeDocuments(), TOKEN, { documents: [anns, bobs] }),
      deps,
    );
    expect(response.status).toBe(409);
    expect((await storage.record(anns))?.trashedAt).toBeUndefined();
    expect((await storage.record(bobs))?.trashedAt).toBeUndefined();
  });

  it('keeps documents shared with everyone shared with everyone', () => {
    const everyone = { owner: null, grants: [] };
    expect(mergedPermissions([everyone, everyone], null)).toEqual(everyone);
  });
});
