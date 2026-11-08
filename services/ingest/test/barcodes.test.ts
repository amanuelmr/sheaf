/** Reading barcodes off scanned pages, and what they ask for. */
import { describe as suite, expect, it } from 'vitest';
import { plan, readBarcodes } from '../src/barcodes';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { DocumentEdits } from '../src/document-edits';
import { Settings } from '../src/settings';
import { barcodeStep } from '../src/steps/barcodes';
import { Storage, sha256Hex } from '../src/storage';
import { names, scanned } from './pdf-helpers';

suite('reading barcodes', () => {
  it('reads a Data Matrix pictured as a JPEG and a QR code as a deflated image, page by page', async () => {
    const pdf = await scanned('cover', { matrix: 'PATCHT' }, { qr: 'ASN00042' });
    expect(await readBarcodes(pdf)).toEqual([[], ['PATCHT'], ['ASN00042']]);
  }, 20_000);
});

suite('what the barcodes ask for', () => {
  it('splits at separator pages, dropping them and empty parts', () => {
    expect(plan([[], ['PATCHT'], [], [], ['PATCHT'], ['PATCHT']], 'PATCHT', 'ASN')).toEqual({
      parts: [[1], [3, 4]],
      asn: null,
    });
  });

  it('takes the first serial number when there is nothing to split', () => {
    expect(plan([['hello'], ['ASN 0007'], ['asn9']], 'PATCHT', 'ASN')).toEqual({
      parts: null,
      asn: 7,
    });
    expect(plan([['ASNx']], 'PATCHT', 'ASN')).toEqual({ parts: null, asn: null });
  });
});

suite('the barcode step', () => {
  async function setUp(enabled: boolean) {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-bc-')),
    });
    const settings = await Settings.open(driver, { barcodesEnabled: enabled });
    const warnings: string[] = [];
    const step = barcodeStep(storage, driver, new DocumentEdits(storage, driver), settings, (m) =>
      warnings.push(m),
    );
    return { driver, storage, step, warnings };
  }
  const NOW = 1_700_000_000_000;

  it('splits a new document at its separator sheet, trashing the bundle', async () => {
    const { storage, step } = await setUp(true);
    const pdf = await scanned('a1', 'a2', { matrix: 'PATCHT' }, 'b1');
    const sha = sha256Hex(pdf);
    await storage.put(sha, pdf, NOW, 4);
    const record = (await storage.record(sha))!;
    expect(await step.applies(record)).toBe(true);
    await step.run(record, { now: NOW });
    expect((await storage.record(sha))?.trashedAt).toBe(NOW);
    const parts = await storage.list();
    expect(await Promise.all(parts.map(async (p) => names(storage.bytes(p.sha256)!)))).toEqual(
      expect.arrayContaining([['a1', 'a2'], ['b1']]),
    );
  }, 20_000);

  it('sets the serial number from its barcode, unless another document has it', async () => {
    const { storage, step, warnings } = await setUp(true);
    const pdf = await scanned({ qr: 'ASN0042' }, 'page 2');
    const sha = sha256Hex(pdf);
    await storage.put(sha, pdf, NOW, 2);
    await step.run((await storage.record(sha))!, { now: NOW });
    expect((await storage.record(sha))?.asn).toBe(42);

    const other = await scanned({ qr: 'ASN42' });
    await storage.put(sha256Hex(other), other, NOW, 1);
    await step.run((await storage.record(sha256Hex(other)))!, { now: NOW });
    expect((await storage.record(sha256Hex(other)))?.asn).toBeNull();
    expect(warnings[0]).toMatch(/ASN 42/);
  }, 20_000);

  it('leaves alone a document already filed, and everything when the setting is off', async () => {
    const on = await setUp(true);
    const pdf = await scanned('x');
    await on.storage.put(sha256Hex(pdf), pdf, NOW, 1);
    await on.driver.run(
      `INSERT INTO jobs (sha256, step, version, state, attempts, created_at) VALUES (?, 'match', 1, 'done', 0, ?)`,
      [sha256Hex(pdf), NOW],
    );
    expect(await on.step.applies((await on.storage.record(sha256Hex(pdf)))!)).toBe(false);
    const off = await setUp(false);
    await off.storage.put(sha256Hex(pdf), pdf, NOW, 1);
    expect(await off.step.applies((await off.storage.record(sha256Hex(pdf)))!)).toBe(false);
  });
});
