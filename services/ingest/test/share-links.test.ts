/** Share links: one document for whoever holds the link, until it expires or is revoked. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { isShareLinkBody, paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { ShareLinks } from '../src/share-links';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const A = pdf('a');
const hashA = sha256Hex(A);
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const TOKEN = 'admin-token-for-share';

let storage: Storage;
let links: ShareLinks;
let clock = NOW;
let deps: Parameters<typeof handle>[1];

const req = (
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): IngestRequest => ({
  method,
  path,
  query: '',
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

beforeEach(async () => {
  clock = NOW;
  const driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-sh-')) });
  links = new ShareLinks(driver, storage);
  deps = { storage, token: TOKEN, now: () => clock, shareLinks: links };
  await storage.put(hashA, A, NOW, 1);
});

suite('share links', () => {
  it('open the document with no token, and nothing else', async () => {
    const made = await handle(req('POST', paths.documentShareLinks(hashA), {}), deps);
    expect(made.status).toBe(201);
    const { slug, expiresAt } = made.json as { slug: string; expiresAt: number | null };
    expect(slug).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiresAt).toBeNull();

    const opened = await handle(req('GET', paths.shared(slug), undefined, null), deps);
    expect(opened.status).toBe(200);
    expect(opened.bytes).toEqual(A);
    expect(opened.headers).toMatchObject({ 'cache-control': 'private, no-store' });

    expect(
      (await handle(req('GET', paths.shared('x'.repeat(32)), undefined, null), deps)).status,
    ).toBe(404);
    expect(
      (await handle(req('GET', paths.documentRecord(hashA), undefined, null), deps)).status,
    ).toBe(401);
  });

  it('stop working when they expire, are revoked, or the document is trashed', async () => {
    const expiring = await links.create(hashA, 7, NOW);
    const lasting = await links.create(hashA, null, NOW);
    clock = NOW + 7 * DAY;
    expect(await links.resolve(expiring!.slug, clock)).toBeNull();
    expect(await links.resolve(lasting!.slug, clock)).toBe(hashA);

    expect((await handle(req('DELETE', paths.shareLink(lasting!.id)), deps)).status).toBe(204);
    expect(await links.resolve(lasting!.slug, clock)).toBeNull();

    const another = await links.create(hashA, null, NOW);
    await storage.trash(hashA, NOW);
    expect(await links.resolve(another!.slug, clock)).toBeNull();
    expect(await links.create(hashA, null, NOW)).toBeNull();
    await storage.restore([hashA]);
    expect(await links.resolve(another!.slug, clock)).toBe(hashA);
  });

  it('are listed newest first and go with the document when it is deleted for good', async () => {
    await links.create(hashA, null, NOW);
    await links.create(hashA, 30, NOW + 1);
    const listed = await handle(req('GET', paths.documentShareLinks(hashA)), deps);
    expect(
      (listed.json as { links: { expiresAt: number | null }[] }).links.map((l) => l.expiresAt),
    ).toEqual([NOW + 1 + 30 * DAY, null]);
    await storage.trash(hashA, NOW);
    await storage.purge(hashA);
    expect(await links.list(hashA)).toEqual([]);
  });

  it('take a whole number of days, or none', () => {
    expect(isShareLinkBody({})).toBe(true);
    expect(isShareLinkBody({ expiresInDays: null })).toBe(true);
    expect(isShareLinkBody({ expiresInDays: 30 })).toBe(true);
    expect(isShareLinkBody({ expiresInDays: 0 })).toBe(false);
    expect(isShareLinkBody({ expiresInDays: 1.5 })).toBe(false);
    expect(isShareLinkBody({ days: 3 })).toBe(false);
  });
});
