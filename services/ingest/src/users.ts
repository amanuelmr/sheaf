import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Role, User, UserBody, UserPatch } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

const SESSION_MS = 30 * 86_400_000;
/** Wrong passwords for one username before it is locked for `LOCK_MS`. */
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: number;
  disabled_at: number | null;
  last_sign_in: number | null;
}

export type SignIn =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number; readonly user: User }
  | { readonly ok: false; readonly reason: 'wrong' | 'locked' };

/** Who a session token belongs to. */
export interface SessionUser {
  readonly id: number;
  readonly username: string;
  readonly role: Role;
}

/**
 * People who sign in with a username and password, each with a role.
 *
 * Passwords are kept only as scrypt hashes, each with its own salt; session tokens
 * only as SHA-256 hashes, like paired phones' (ADR 0008). A wrong password and an
 * unknown username take the same time and give the same answer, and ten wrong
 * passwords in a row lock that username for fifteen minutes.
 */
export class Users {
  readonly #driver: SqlDriver;
  /** Recent failures by username, kept in memory: a restart forgives them. */
  readonly #failures = new Map<string, number[]>();

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  /** Every user's id and name, for choosing whom to share a document with. */
  async directory(): Promise<readonly { id: number; username: string }[]> {
    return this.#driver.all<{ id: number; username: string }>(
      'SELECT id, username FROM users WHERE disabled_at IS NULL ORDER BY username',
    );
  }

  async list(): Promise<readonly User[]> {
    const rows = await this.#driver.all<UserRow>('SELECT * FROM users ORDER BY username');
    return rows.map(toUser);
  }

  async create(body: UserBody, now: number): Promise<User | 'taken'> {
    const existing = await this.#driver.all<{ id: number }>(
      'SELECT id FROM users WHERE username = ?',
      [body.username],
    );
    if (existing.length > 0) return 'taken';
    await this.#driver.run(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      [body.username, await hashPassword(body.password), body.role, now],
    );
    return (await this.#byName(body.username))!;
  }

  async update(id: number, patch: UserPatch, now: number): Promise<User | null> {
    const current = await this.#byId(id);
    if (current === null) return null;
    await this.#driver.transaction(async () => {
      if (patch.password !== undefined) {
        await this.#driver.run('UPDATE users SET password_hash = ? WHERE id = ?', [
          await hashPassword(patch.password),
          id,
        ]);
      }
      if (patch.role !== undefined) {
        await this.#driver.run('UPDATE users SET role = ? WHERE id = ?', [patch.role, id]);
      }
      if (patch.disabled !== undefined) {
        await this.#driver.run('UPDATE users SET disabled_at = ? WHERE id = ?', [
          patch.disabled ? now : null,
          id,
        ]);
      }
      // A new password or a disabled account ends every session it had.
      if (patch.password !== undefined || patch.disabled === true) {
        await this.#driver.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
    });
    return this.#byId(id);
  }

  async remove(id: number): Promise<boolean> {
    if ((await this.#byId(id)) === null) return false;
    await this.#driver.transaction(async () => {
      await this.#driver.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      // What was theirs is shared with everyone again, rather than owned by no one.
      await this.#driver.run('UPDATE documents SET owner_id = NULL WHERE owner_id = ?', [id]);
      await this.#driver.run('DELETE FROM document_grants WHERE user_id = ?', [id]);
      await this.#driver.run('DELETE FROM users WHERE id = ?', [id]);
    });
    return true;
  }

  async signIn(username: string, password: string, now: number): Promise<SignIn> {
    const key = username.toLowerCase();
    const recent = (this.#failures.get(key) ?? []).filter((at) => now - at < LOCK_MS);
    if (recent.length >= MAX_FAILURES) return { ok: false, reason: 'locked' };

    const row = await this.#row(key);
    // Hash something either way, so an unknown username takes as long as a wrong password.
    const matches = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (row === null || !matches || row.disabled_at !== null) {
      this.#failures.set(key, [...recent, now]);
      return { ok: false, reason: 'wrong' };
    }
    this.#failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_MS;
    await this.#driver.transaction(async () => {
      await this.#driver.run(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [hashToken(token), row.id, now, expiresAt],
      );
      await this.#driver.run('UPDATE users SET last_sign_in = ? WHERE id = ?', [now, row.id]);
      await this.#driver.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
    });
    return { ok: true, token, expiresAt, user: (await this.#byId(row.id))! };
  }

  /** The user a session token belongs to, while it lasts and they may sign in. */
  async authenticate(token: string, now: number): Promise<SessionUser | null> {
    const rows = await this.#driver.all<{ id: number; username: string; role: Role }>(
      `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
      [hashToken(token), now],
    );
    return rows[0] ?? null;
  }

  async signOut(token: string): Promise<void> {
    await this.#driver.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  }

  async #row(username: string): Promise<UserRow | null> {
    const rows = await this.#driver.all<UserRow>('SELECT * FROM users WHERE username = ?', [
      username,
    ]);
    return rows[0] ?? null;
  }

  async #byName(username: string): Promise<User | null> {
    const row = await this.#row(username);
    return row === null ? null : toUser(row);
  }

  async #byId(id: number): Promise<User | null> {
    const rows = await this.#driver.all<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    lastSignIn: row.last_sign_in,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash`, so the cost can rise later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash no password matches, to spend the same time on a username that does not exist. */
const DUMMY_HASH = `scrypt$${String(SCRYPT.N)}$${String(SCRYPT.r)}$${String(SCRYPT.p)}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;
