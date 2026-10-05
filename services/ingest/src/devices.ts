import { createHash, randomBytes } from 'node:crypto';
import type { SqlDriver } from '@sheaf/store';

/** How long a pairing code works for. Long enough to pick up a phone and scan. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
/** How often `last_seen` is written, at most: a busy phone is not a write per request. */
const LAST_SEEN_EVERY_MS = 60_000;
const NAME_LIMIT = 64;
/** Recognisable in a log or a leak scanner, like other services' token prefixes. */
const TOKEN_PREFIX = 'shf_dev_';

export interface DevicesPorts {
  now(): number;
  /** Cryptographically random bytes. Injected only so tests can see what was made. */
  random?(size: number): Uint8Array;
}

export type DeviceIdentity = {
  readonly kind: 'device';
  readonly id: string;
  readonly name: string;
};

export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number | null;
  readonly revoked: boolean;
}

/**
 * Phones that may use this server, each with its own token (ADR 0008).
 *
 * A phone joins by presenting a one-time pairing code, which an admin creates and
 * shows as a QR code. Codes and tokens are stored only as SHA-256 hashes: looking one
 * up by its hash is not a timing oracle, and a copy of the database lets nobody in.
 */
export class Devices {
  readonly #driver: SqlDriver;
  readonly #ports: DevicesPorts;
  readonly #random: (size: number) => Uint8Array;
  readonly #lastSeenWritten = new Map<string, number>();

  constructor(driver: SqlDriver, ports: DevicesPorts) {
    this.#driver = driver;
    this.#ports = ports;
    this.#random =
      ports.random === undefined
        ? (size) => new Uint8Array(randomBytes(size))
        : (size) => ports.random!(size);
  }

  /** A code good for one pairing, for the next five minutes. */
  async createPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const code = format(base32(this.#random(16)));
    const now = this.#ports.now();
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    await this.#driver.run(
      'INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)',
      [hash(normaliseCode(code)), now, expiresAt],
    );
    return { code, expiresAt };
  }

  /**
   * Exchange a code for a device token, shown this once and never again. Null for a
   * code that is unknown, used or expired, without saying which.
   */
  async pair(code: string, name: string): Promise<{ deviceId: string; token: string } | null> {
    const now = this.#ports.now();
    const codeHash = hash(normaliseCode(code));
    return this.#driver.transaction(async () => {
      // One connection, one transaction: no second pairing can see this code as
      // unused between the check and the update.
      const usable = await this.#driver.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pairing_codes
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
        [codeHash, now],
      );
      if ((usable[0]?.n ?? 0) === 0) return null;
      await this.#driver.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', [
        now,
        codeHash,
      ]);

      const deviceId = hex(this.#random(16));
      const token = TOKEN_PREFIX + base64url(this.#random(32));
      await this.#driver.run(
        `INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`,
        [deviceId, cleanName(name), hash(token), now],
      );
      return { deviceId, token };
    });
  }

  /** Who a bearer token belongs to: a device, a revoked one, or nobody (null). */
  async authenticate(token: string): Promise<DeviceIdentity | { kind: 'revoked' } | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const rows = await this.#driver.all<{ id: string; name: string; revoked_at: number | null }>(
      'SELECT id, name, revoked_at FROM devices WHERE token_hash = ?',
      [hash(token)],
    );
    const device = rows[0];
    if (device === undefined) return null;
    if (device.revoked_at !== null) return { kind: 'revoked' };

    const now = this.#ports.now();
    const written = this.#lastSeenWritten.get(device.id);
    if (written === undefined || now - written >= LAST_SEEN_EVERY_MS) {
      this.#lastSeenWritten.set(device.id, now);
      await this.#driver.run('UPDATE devices SET last_seen = ? WHERE id = ?', [now, device.id]);
    }
    return { kind: 'device', id: device.id, name: device.name };
  }

  async list(): Promise<readonly DeviceSummary[]> {
    const rows = await this.#driver.all<{
      id: string;
      name: string;
      created_at: number;
      last_seen: number | null;
      revoked_at: number | null;
    }>('SELECT id, name, created_at, last_seen, revoked_at FROM devices ORDER BY created_at');
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      revoked: row.revoked_at !== null,
    }));
  }

  /** Stop a device's token working. True if the device exists; repeating is harmless. */
  async revoke(id: string): Promise<boolean> {
    await this.#driver.run('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [
      this.#ports.now(),
      id,
    ]);
    const rows = await this.#driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM devices WHERE id = ?',
      [id],
    );
    return (rows[0]?.n ?? 0) > 0;
  }
}

/** A code as typed or scanned, reduced to its letters and digits, upper case. */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
  return trimmed === '' ? 'Unnamed device' : trimmed;
}

/** RFC 4648 base32 without padding: no 0/1/8 to confuse with O/I/B when typed. */
function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Groups of four, so a code read off a screen can be typed without losing place. */
function format(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
