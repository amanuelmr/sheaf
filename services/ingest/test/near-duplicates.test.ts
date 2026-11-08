/** Finding the same paper scanned twice, by its words. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import {
  NearDuplicates,
  numbers,
  numbersAgree,
  signature,
  similarity,
} from '../src/near-duplicates';
import { Storage, sha256Hex } from '../src/storage';

const LETTER = `Dear Ms Alvarez, thank you for your payment of 412.50 EUR received on
  3 March 2026 for invoice 20931. Your next meter reading is due in June. Please keep
  this letter for your records. City Power customer service, 14 Harbour Road.`;
/** The same letter through a worse camera: a few words misread, a line lost. */
const RESCAN = `Dear Ms Alvarez, thank you for your payrnent of 412.50 EUR received on
  3 March 2026 for invoice 20931. Your next meter readinq is due in June. Please keep
  this letter for your records. City Power customer service.`;
const OTHER = `Dear Ms Alvarez, your water bill for the first quarter is 88.20 EUR and is
  due on 30 April 2026. Pay by bank transfer quoting account 5521. Water Co, 2 Mill Lane,
  questions answered weekdays from nine to five.`;

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const NOW = 1_700_000_000_000;

suite('text signatures', () => {
  it('rate a re-scan close and a different letter from the same sender far', () => {
    const [a, b, c] = [signature(LETTER)!, signature(RESCAN)!, signature(OTHER)!];
    expect(similarity(a, a)).toBe(1);
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.6);
    expect(similarity(a, c)).toBeLessThan(0.2);
  });

  it('tell apart bills from one template by their numbers, but not a misread digit', () => {
    const bill = (n: number, total: string, date: string) =>
      `Corner Shop receipt number ${String(n)} Total ${total} EUR Date ${date} Thank you for
       shopping with us today, please come again soon to the corner shop on Mill Lane.`;
    const [a, b] = [bill(1000, '10.40', '01/02/2026'), bill(1001, '11.40', '02/02/2026')];
    expect(similarity(signature(a)!, signature(b)!)).toBeGreaterThanOrEqual(0.6);
    expect(numbersAgree(numbers(a), numbers(b))).toBe(false);
    expect(numbersAgree(numbers(LETTER), numbers(RESCAN))).toBe(true);
    expect(numbersAgree(numbers('no digits at all'), numbers('none here either'))).toBe(true);
  });

  it('say nothing about a page with hardly any words', () => {
    expect(signature('Page 2 of 3')).toBeNull();
  });
});

suite('near-duplicate documents', () => {
  it('point a re-scan at the earlier document, in the inbox and on request', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-nd-')),
    });
    const docs = [pdf('first'), pdf('second'), pdf('other')].map((bytes) => ({
      bytes,
      sha: sha256Hex(bytes),
    }));
    for (const [i, { bytes, sha }] of docs.entries()) {
      await storage.put(sha, bytes, NOW + i, 1);
      await driver.run('UPDATE documents SET suggestions_json = ? WHERE sha256 = ?', [
        JSON.stringify({ title: `Letter ${String(i)}` }),
        sha,
      ]);
    }
    const [first, second, other] = docs.map((d) => d.sha) as [string, string, string];
    await storage.putText(first, { source: 'edge', engine: 'x', text: LETTER }, NOW);
    await storage.putText(second, { source: 'edge', engine: 'x', text: RESCAN }, NOW);
    await storage.putText(other, { source: 'edge', engine: 'x', text: OTHER }, NOW);

    const inbox = await storage.inbox();
    expect(inbox.find((e) => e.sha256 === second)?.looksLike?.sha256).toBe(first);
    expect(inbox.find((e) => e.sha256 === other)?.looksLike).toBeUndefined();

    const near = new NearDuplicates(driver);
    expect((await near.similarTo(first, null)).map((d) => d.sha256)).toEqual([second]);

    // Trashed, it is no longer pointed at.
    await storage.trash(first, NOW);
    expect((await storage.inbox()).find((e) => e.sha256 === second)?.looksLike).toBeUndefined();
    expect(await near.similarTo(second, null)).toEqual([]);
  });
});
