/** Document files encrypted on disk. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { decrypt, encrypt, isEncrypted, keyFrom } from '../src/encryption';
import { Storage, sha256Hex } from '../src/storage';

const NOW = 1_700_000_000_000;
const KEY = keyFrom('correct horse battery staple');
const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));

suite('encrypting document files', () => {
  it('round-trips, and refuses a wrong key or a changed byte', () => {
    const plain = pdf('secret letter');
    const sealed = encrypt(KEY, plain);
    expect(isEncrypted(sealed)).toBe(true);
    expect(Buffer.from(sealed).includes(Buffer.from('secret letter'))).toBe(false);
    expect(decrypt(KEY, sealed)).toEqual(plain);
    expect(() => decrypt(keyFrom('another passphrase entirely'), sealed)).toThrow();
    const tampered = new Uint8Array(sealed);
    tampered[30] = tampered[30]! ^ 1;
    expect(() => decrypt(KEY, tampered)).toThrow();
    expect(() => keyFrom('short')).toThrow(/at least 16/);
  });

  it('stores files encrypted, reads them back plain, and encrypts files stored before', async () => {
    const driver = nodeSqliteDriver();
    const objectsDir = mkdtempSync(join(tmpdir(), 'sheaf-enc-'));
    const plainStore = await Storage.open({ driver, objectsDir });
    const old = pdf('stored before encryption');
    await plainStore.put(sha256Hex(old), old, NOW, 1);

    const storage = await Storage.open({ driver, objectsDir, key: KEY });
    const fresh = pdf('stored after');
    await storage.put(sha256Hex(fresh), fresh, NOW, 1);
    expect(isEncrypted(new Uint8Array(readFileSync(storage.pathFor(sha256Hex(fresh)))))).toBe(true);
    expect(storage.bytes(sha256Hex(fresh))).toEqual(fresh);
    // Stored in the clear before: still readable, then encrypted.
    expect(storage.bytes(sha256Hex(old))).toEqual(old);
    expect(await storage.encryptStored()).toBe(1);
    expect(isEncrypted(new Uint8Array(readFileSync(storage.pathFor(sha256Hex(old)))))).toBe(true);
    expect(storage.bytes(sha256Hex(old))).toEqual(old);
    expect(await storage.encryptStored()).toBe(0);

    // A script gets a plain copy, which is gone afterwards.
    let seen = '';
    const copy = await storage.withPlainFile(sha256Hex(fresh), (path) => {
      seen = path;
      return Promise.resolve(readFileSync(path, 'latin1'));
    });
    expect(copy).toContain('stored after');
    expect(() => readFileSync(seen)).toThrow();

    // Without the key, an encrypted file is refused, not handed out as garbage.
    const keyless = await Storage.open({ driver, objectsDir });
    expect(() => keyless.bytes(sha256Hex(fresh))).toThrow(/SHEAF_ENCRYPTION_KEY/);
  });
});
