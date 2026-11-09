import type { SqlDriver } from '@sheaf/store';
import { plan, readBarcodes } from '../barcodes.ts';
import { AsnSeriesStore } from '../asn-series.ts';
import type { DocumentEdits } from '../document-edits.ts';
import type { Step } from '../jobs.ts';
import type { Settings } from '../settings.ts';
import type { Storage } from '../storage.ts';

/**
 * Reads the barcodes on a new document, when the setting is on: a separator sheet
 * splits the document there, and a serial number barcode gives it its ASN. It runs
 * before anything files the document, so each part is filed as an arrival of its
 * own, and only for new documents: one already filed is never split after the fact.
 */
export function barcodeStep(
  storage: Storage,
  driver: SqlDriver,
  edits: DocumentEdits,
  settings: Settings,
  warn: (message: string) => void,
): Step {
  return {
    name: 'barcodes',
    version: 1,
    after: [],
    budget: 3,

    async applies(document) {
      if (!settings.current().barcodesEnabled || document.trashedAt !== undefined) return false;
      const filed = await driver.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs WHERE sha256 = ? AND step = 'match' AND state = 'done'`,
        [document.sha256],
      );
      return (filed[0]?.n ?? 0) === 0;
    },

    async run(document, context) {
      const bytes = storage.bytes(document.sha256);
      if (bytes === null) return { ok: true, value: null };
      const { barcodeSeparator, barcodeAsnPrefix } = settings.current();
      let pages: string[][];
      try {
        pages = await readBarcodes(bytes);
      } catch {
        // Not a PDF pdf-lib can read: nothing to find, and nothing to retry.
        return { ok: true, value: null };
      }
      const series = await new AsnSeriesStore(driver).list();
      const wanted = plan(pages, barcodeSeparator, [
        { prefix: barcodeAsnPrefix, first: 1 },
        ...series,
      ]);
      if (wanted.parts !== null) {
        const whole = wanted.parts.length === 1 && wanted.parts[0]!.length === pages.length;
        if (!whole && wanted.parts.length > 0) {
          await edits.splitArrival(document.sha256, wanted.parts, context.now);
        }
      } else if (wanted.asn !== null && document.asn === null) {
        if (!(await storage.setAsnIfFree(document.sha256, wanted.asn))) {
          warn(`barcodes: ASN ${String(wanted.asn)} on ${document.sha256} is another document's`);
        }
      }
      return { ok: true, value: null };
    },
  };
}
