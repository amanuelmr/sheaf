/** A folder a scanner drops PDFs into: taken in once complete, then cleared. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { ConsumeFolder } from '../src/consume';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Buffer => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`);
const NOW = 1_700_000_000_000;

let storage: Storage;
let dir: string;

beforeEach(async () => {
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-co-')),
  });
  dir = mkdtempSync(join(tmpdir(), 'sheaf-consume-'));
});

const folder = (subdirsAsTags = false) =>
  new ConsumeFolder(storage, dir, { subdirsAsTags, now: () => NOW });

suite('the consume folder', () => {
  it('waits for a file to stop growing, then stores it and clears it away', async () => {
    const consume = folder();
    writeFileSync(join(dir, 'scan.pdf'), pdf('part'));
    expect(await consume.tick()).toEqual({ stored: 0, duplicates: 0, failed: 0 });
    writeFileSync(join(dir, 'scan.pdf'), pdf('part and the rest'));
    expect(await consume.tick()).toEqual({ stored: 0, duplicates: 0, failed: 0 });
    expect(await consume.tick()).toEqual({ stored: 1, duplicates: 0, failed: 0 });
    expect(await storage.has(sha256Hex(pdf('part and the rest')))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('counts a document it already has, and still clears the file', async () => {
    await storage.put(sha256Hex(pdf('x')), new Uint8Array(pdf('x')), NOW, 1);
    const consume = folder();
    writeFileSync(join(dir, 'again.pdf'), pdf('x'));
    await consume.tick();
    expect(await consume.tick()).toEqual({ stored: 0, duplicates: 1, failed: 0 });
    expect(existsSync(join(dir, 'again.pdf'))).toBe(false);
  });

  it('moves what is not a PDF to failed/, keeping its folders, and leaves hidden files', async () => {
    const consume = folder();
    mkdirSync(join(dir, 'tax'));
    writeFileSync(join(dir, 'tax', 'photo.jpg'), 'jpeg');
    writeFileSync(join(dir, 'fake.pdf'), 'not really');
    writeFileSync(join(dir, '.partial'), 'hidden');
    await consume.tick();
    expect(await consume.tick()).toEqual({ stored: 0, duplicates: 0, failed: 2 });
    expect(existsSync(join(dir, 'failed', 'tax', 'photo.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'failed', 'fake.pdf'))).toBe(true);
    expect(existsSync(join(dir, '.partial'))).toBe(true);
    expect(await consume.tick()).toEqual({ stored: 0, duplicates: 0, failed: 0 });
  });

  it('tags a document with the folders it was in, without making them a person’s choice', async () => {
    const consume = folder(true);
    mkdirSync(join(dir, 'home', 'insurance'), { recursive: true });
    writeFileSync(join(dir, 'home', 'insurance', 'policy.pdf'), pdf('policy'));
    await consume.tick();
    await consume.tick();
    const sha = sha256Hex(pdf('policy'));
    expect((await storage.record(sha))?.tags).toEqual(['home', 'insurance']);
    expect((await storage.fields(sha)).find((f) => f.name === 'tags')).toBeUndefined();
  });
});
