/** People who sign in: passwords kept as hashes, sessions that end, and roles that hold. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';
import { Labels } from '../src/labels';
import { Users, hashPassword, verifyPassword } from '../src/users';

const TOKEN = 'admin-token-for-users';
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const PASSWORD = 'correct horse battery';

let driver: SqlDriver;
let users: Users;
let clock: number;
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

async function signIn(username: string, password = PASSWORD): Promise<string> {
  const response = await handle(req('POST', paths.sessions(), { username, password }, null), deps);
  return (response.json as { token: string }).token;
}

beforeEach(async () => {
  clock = NOW;
  driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-us-')),
  });
  users = new Users(driver);
  deps = { storage, token: TOKEN, now: () => clock, users, labels: new Labels(driver, storage) };
  for (const [username, role] of [
    ['ada', 'admin'],
    ['ed', 'editor'],
    ['vi', 'viewer'],
  ] as const) {
    await users.create({ username, password: PASSWORD, role }, NOW);
  }
});

suite('passwords', () => {
  it('are kept as salted scrypt hashes, never as they were typed', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword('wrong password', a)).toBe(false);
    const rows = await driver.all<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(rows.every((row) => row.password_hash.startsWith('scrypt$'))).toBe(true);
  });
});

suite('creating users', () => {
  it('says a name is taken when two people ask for it at once', async () => {
    const body = { username: 'twin', password: 'a long enough password', role: 'editor' as const };
    const made = await Promise.all([users.create(body, NOW), users.create(body, NOW)]);
    expect(made.filter((m) => m === 'taken')).toHaveLength(1);
  });
});

suite('signing in', () => {
  it('gives a token that works until it expires, and signing out ends it', async () => {
    const signed = await handle(
      req('POST', paths.sessions(), { username: 'ed', password: PASSWORD }, null),
      deps,
    );
    expect(signed.status).toBe(201);
    const { token, user } = signed.json as {
      token: string;
      user: { username: string; role: string };
    };
    expect(user).toMatchObject({ username: 'ed', role: 'editor' });
    expect((await handle(req('GET', paths.me(), undefined, token), deps)).json).toEqual({
      kind: 'user',
      id: 2,
      role: 'editor',
      name: 'ed',
    });
    expect(
      (await handle(req('DELETE', paths.currentSession(), undefined, token), deps)).status,
    ).toBe(204);
    expect((await handle(req('GET', paths.me(), undefined, token), deps)).status).toBe(401);

    const again = await signIn('ed');
    clock = NOW + 31 * DAY;
    expect((await handle(req('GET', paths.me(), undefined, again), deps)).status).toBe(401);
  });

  it('answers a wrong password and an unknown name the same, and locks after ten tries', async () => {
    const wrong = await handle(
      req('POST', paths.sessions(), { username: 'ed', password: 'nope nope nope' }, null),
      deps,
    );
    const unknown = await handle(
      req('POST', paths.sessions(), { username: 'zz', password: PASSWORD }, null),
      deps,
    );
    expect(wrong).toEqual(unknown);
    expect(wrong.status).toBe(401);
    for (let i = 0; i < 9; i++) {
      await users.signIn('ed', 'still wrong!!', clock);
    }
    expect(
      (
        await handle(
          req('POST', paths.sessions(), { username: 'ed', password: PASSWORD }, null),
          deps,
        )
      ).status,
    ).toBe(429);
    clock += 16 * 60_000;
    expect(
      (
        await handle(
          req('POST', paths.sessions(), { username: 'ED', password: PASSWORD }, null),
          deps,
        )
      ).status,
    ).toBe(201);
  });

  it('refuses a disabled user, and a new password ends old sessions', async () => {
    const token = await signIn('ed');
    const ed = (await users.list()).find((u) => u.username === 'ed')!;
    await users.update(ed.id, { password: 'another long one' }, NOW);
    expect((await handle(req('GET', paths.me(), undefined, token), deps)).status).toBe(401);
    await users.update(ed.id, { disabled: true }, NOW);
    expect((await users.signIn('ed', 'another long one', NOW)).ok).toBe(false);
  });
});

suite('roles', () => {
  it('lets a viewer read but not change anything', async () => {
    const token = await signIn('vi');
    expect((await handle(req('GET', paths.labels('tag'), undefined, token), deps)).status).toBe(
      200,
    );
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\nv\n%%EOF\n'));
    const put = await handle(
      { ...req('PUT', paths.document(sha256Hex(pdf)), undefined, token), body: pdf },
      deps,
    );
    expect(put.status).toBe(403);
  });

  it('lets an editor change documents but not manage labels or users', async () => {
    const token = await signIn('ed');
    expect(
      (await handle(req('POST', paths.labels('tag'), { name: 'x' }, token), deps)).status,
    ).toBe(403);
    expect((await handle(req('GET', paths.users(), undefined, token), deps)).status).toBe(403);
  });

  it('lets an admin user do what the admin token does, but not demote or remove themselves', async () => {
    const token = await signIn('ada');
    expect(
      (await handle(req('POST', paths.labels('tag'), { name: 'x' }, token), deps)).status,
    ).toBe(201);
    const made = await handle(
      req(
        'POST',
        paths.users(),
        { username: 'new.one', password: PASSWORD, role: 'viewer' },
        token,
      ),
      deps,
    );
    expect(made.status).toBe(201);
    expect(
      (
        await handle(
          req(
            'POST',
            paths.users(),
            { username: 'new.one', password: PASSWORD, role: 'viewer' },
            token,
          ),
          deps,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handle(
          req(
            'POST',
            paths.users(),
            { username: 'Bad Name', password: PASSWORD, role: 'viewer' },
            token,
          ),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handle(
          req(
            'POST',
            paths.users(),
            { username: 'short', password: 'short', role: 'viewer' },
            token,
          ),
          deps,
        )
      ).status,
    ).toBe(400);
    const ada = (await users.list()).find((u) => u.username === 'ada')!;
    expect(
      (await handle(req('PATCH', paths.user(ada.id), { role: 'viewer' }, token), deps)).status,
    ).toBe(400);
    expect((await handle(req('DELETE', paths.user(ada.id), undefined, token), deps)).status).toBe(
      400,
    );
    const listed = (await handle(req('GET', paths.users(), undefined, token), deps)).json as {
      users: object[];
    };
    expect(JSON.stringify(listed)).not.toContain('scrypt');
  });
});
