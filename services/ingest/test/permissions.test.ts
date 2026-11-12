/** Per-document permissions: what a person uploads is theirs, to share as they choose. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { BulkEditor } from '../src/bulk';
import { handle, type IngestRequest } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';
import { Users } from '../src/users';

const TOKEN = 'admin-token-for-permissions';
const NOW = 1_700_000_000_000;
const PASSWORD = 'a long enough password';
const pdf = (s: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const MINE = pdf('mine');
const SHARED = pdf('shared');

let deps: Parameters<typeof handle>[1];
let users: Users;
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

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-pm-')),
  });
  users = new Users(driver);
  deps = { storage, token: TOKEN, now: () => NOW, users, bulk: new BulkEditor(storage) };
  tokens = {};
  ids = {};
  for (const [name, role] of [
    ['ann', 'editor'],
    ['bob', 'editor'],
    ['cat', 'viewer'],
  ] as const) {
    const made = await users.create({ username: name, password: PASSWORD, role }, NOW);
    if (made === 'taken') throw new Error(name);
    ids[name] = made.id;
    const signed = await users.signIn(name, PASSWORD, NOW);
    if (!signed.ok) throw new Error(name);
    tokens[name] = signed.token;
  }
  await handle(req('PUT', paths.document(sha256Hex(MINE)), tokens['ann']!, MINE), deps);
  await handle(req('PUT', paths.document(sha256Hex(SHARED)), TOKEN, SHARED), deps);
});

const mine = sha256Hex(MINE);
const shared = sha256Hex(SHARED);
const seen = async (who: string) =>
  (
    (await handle({ ...req('GET', paths.search(), tokens[who]!), query: '' }, deps)).json as {
      hits: { sha256: string }[];
    }
  ).hits.map((hit) => hit.sha256);

suite('per-document permissions', () => {
  it('makes an upload its uploader’s, unseen by others, and keeps phone and admin uploads shared', async () => {
    expect((await deps.storage.record(mine))?.owner).toBe(ids['ann']);
    expect((await deps.storage.record(shared))?.owner).toBeNull();
    expect((await seen('ann')).sort()).toEqual([mine, shared].sort());
    expect(await seen('bob')).toEqual([shared]);
    expect(
      (await handle(req('GET', paths.documentRecord(mine), tokens['bob']!), deps)).status,
    ).toBe(404);
    expect((await handle(req('GET', paths.document(mine), tokens['bob']!), deps)).status).toBe(404);
    // An admin sees everything.
    expect((await handle(req('GET', paths.documentRecord(mine), TOKEN), deps)).status).toBe(200);
  });

  it('lets the owner share to read or to change, and nobody else decide', async () => {
    const grant = { owner: ids['ann'], grants: [{ user: ids['bob'], level: 'view' }] };
    expect(
      (await handle(req('PUT', paths.documentPermissions(mine), tokens['bob']!, grant), deps))
        .status,
    ).toBe(404);
    expect(
      (await handle(req('PUT', paths.documentPermissions(mine), tokens['ann']!, grant), deps)).json,
    ).toEqual(grant);

    expect(await seen('bob')).toContain(mine);
    const edit = req('PATCH', paths.document(mine), tokens['bob']!, { title: 'mine now' });
    expect((await handle(edit, deps)).status).toBe(403);
    const bulk = req('POST', paths.bulkEdit(), tokens['bob']!, {
      documents: [mine],
      action: { kind: 'trash' },
    });
    expect((await handle(bulk, deps)).status).toBe(403);

    await handle(
      req('PUT', paths.documentPermissions(mine), tokens['ann']!, {
        owner: ids['ann'],
        grants: [{ user: ids['bob'], level: 'change' }],
      }),
      deps,
    );
    expect((await handle(edit, deps)).status).toBe(200);
    expect(
      (
        await handle(
          req('PUT', paths.documentPermissions(mine), tokens['ann']!, { owner: 999, grants: [] }),
          deps,
        )
      ).status,
    ).toBe(400);
  });

  it('shares a document with everyone again when its owner is removed', async () => {
    await users.remove(ids['ann']!);
    expect((await deps.storage.record(mine))?.owner).toBeNull();
    expect(await seen('bob')).toContain(mine);
  });

  it('keeps the archive and the user directory to what each may know', async () => {
    expect((await handle(req('GET', paths.archive(), tokens['bob']!), deps)).status).toBe(403);
    const directory = (await handle(req('GET', paths.userDirectory(), tokens['cat']!), deps))
      .json as {
      users: { username: string }[];
    };
    expect(directory.users.map((u) => u.username)).toEqual(['ann', 'bob', 'cat']);
    expect(JSON.stringify(directory)).not.toContain('role');
  });
});

suite('trying a background step again', () => {
  it('is for admins, and names the step', async () => {
    const asked: string[] = [];
    const withJobs = {
      ...deps,
      jobs: {
        retryGivenUp: (step: string) => {
          asked.push(step);
          return Promise.resolve(step === 'extract' ? 3 : null);
        },
      },
    };
    const retry = (token: string, step: string) =>
      handle(req('POST', paths.retryJobs(), token, { step }), withJobs);
    expect((await retry(tokens['ann']!, 'extract')).status).toBe(403);
    expect(asked).toEqual([]);
    const done = await retry(TOKEN, 'extract');
    expect(done).toMatchObject({ status: 200, json: { retried: 3 } });
    expect((await retry(TOKEN, 'nothing')).status).toBe(404);
  });
});
