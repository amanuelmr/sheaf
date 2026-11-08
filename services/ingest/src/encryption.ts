import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Document files encrypted where they lie, so a stolen disk or a copied backup of
 * the data folder gives away nothing but sizes.
 *
 * Each file is AES-256-GCM under one key, with a fresh nonce: a marker, the nonce,
 * the ciphertext, and the tag that proves nothing was changed. A file without the
 * marker is read as it is, so a server can start encrypting with files already
 * stored, and encrypt those as it goes.
 */

const MAGIC = Buffer.from('SHEAFENC1\n', 'latin1');
const NONCE = 12;
const TAG = 16;
/** The shortest passphrase taken: anything shorter is guessable. */
export const MIN_PASSPHRASE = 16;

/** A 32-byte key from the operator's passphrase. Slow on purpose, and only once. */
export function keyFrom(passphrase: string): Buffer {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`SHEAF_ENCRYPTION_KEY must be at least ${String(MIN_PASSPHRASE)} characters`);
  }
  // A fixed salt: the key must come out the same on every start, and the passphrase
  // is the operator's own, not one of many users' passwords sharing a table.
  return scryptSync(passphrase, 'sheaf document files v1', 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 << 20,
  });
}

export function isEncrypted(file: Uint8Array): boolean {
  return file.length >= MAGIC.length && Buffer.from(file.subarray(0, MAGIC.length)).equals(MAGIC);
}

export function encrypt(key: Buffer, plain: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]));
}

/** Throws when the key is wrong or the file was changed. */
export function decrypt(key: Buffer, file: Uint8Array): Uint8Array {
  const start = MAGIC.length;
  const nonce = file.subarray(start, start + NONCE);
  const tag = file.subarray(file.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(
    Buffer.concat([
      decipher.update(file.subarray(start + NONCE, file.length - TAG)),
      decipher.final(),
    ]),
  );
}
