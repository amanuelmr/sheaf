/**
 * Hand-written documents from places that write dates and amounts differently:
 * month first, day first, year first, month names in their own language, comma
 * decimals, apostrophe thousands, currencies with no minor unit. Each says which
 * date order and currency the server would be set to there, so a run checks the
 * settings do what they say. Small and made up on purpose: every value is known.
 */
import type { DateOrder } from '../src/normalise.ts';
import type { Expected } from './golden.ts';

export interface LocaleDocument {
  readonly id: string;
  readonly dateOrder: DateOrder;
  readonly currency: string;
  readonly text: string;
  readonly expected: Expected;
}

export const LOCALE_TODAY = '2026-11-09';

export const LOCALE_DOCUMENTS: readonly LocaleDocument[] = [
  {
    id: 'en-us-invoice',
    dateOrder: 'MDY',
    currency: 'USD',
    text: 'Bayside Plumbing LLC\n1200 Harbor Blvd, Oakland CA\nINVOICE\nDate: 04/03/2026\nService call 1 $95.00\nParts $1,139.56\nTOTAL DUE $1,234.56\nThank you',
    expected: {
      correspondent: 'Bayside Plumbing LLC',
      date: '2026-04-03',
      total: { minor: 123456, currency: 'USD' },
    },
  },
  {
    id: 'en-us-receipt-month-name',
    dateOrder: 'MDY',
    currency: 'USD',
    text: 'GREENLEAF MARKET\nMarch 7, 2026 10:42 AM\nApples 3.20\nBread 4.50\nSubtotal 7.70\nTax 0.62\nTotal $8.32\nVISA ****1234',
    expected: {
      correspondent: 'GREENLEAF MARKET',
      date: '2026-03-07',
      total: { minor: 832, currency: 'USD' },
    },
  },
  {
    id: 'en-gb-bill',
    dateOrder: 'DMY',
    currency: 'GBP',
    text: 'Thames Water Utilities Ltd\nYour bill\nBill date 04/03/2026\nAmount due £1,234.56\nPay by 25 March 2026',
    expected: {
      correspondent: 'Thames Water Utilities Ltd',
      date: '2026-03-04',
      total: { minor: 123456, currency: 'GBP' },
    },
  },
  {
    id: 'de-rechnung',
    dateOrder: 'DMY',
    currency: 'EUR',
    text: 'Stadtwerke Musterstadt GmbH\nRechnung Nr. 2026-0042\nRechnungsdatum: 04.03.2026\nVerbrauch Strom 1.100,00 €\nMwSt. 19 % 134,56 €\nGesamtbetrag 1.234,56 €',
    expected: {
      correspondent: 'Stadtwerke Musterstadt GmbH',
      date: '2026-03-04',
      total: { minor: 123456, currency: 'EUR' },
    },
  },
  {
    id: 'de-month-name',
    dateOrder: 'DMY',
    currency: 'EUR',
    text: 'Bäckerei Sonnenschein\nBerlin, den 3. März 2026\nBrötchen 2,40\nKuchen 3,10\nSumme EUR 5,50',
    expected: {
      correspondent: 'Bäckerei Sonnenschein',
      date: '2026-03-03',
      total: { minor: 550, currency: 'EUR' },
    },
  },
  {
    id: 'fr-facture',
    dateOrder: 'DMY',
    currency: 'EUR',
    text: 'Boulangerie du Marché SARL\nFacture du 12 février 2026\nPain 1,20 €\nCroissants 4,80 €\nTotal TTC 6,00 €',
    expected: {
      correspondent: 'Boulangerie du Marché SARL',
      date: '2026-02-12',
      total: { minor: 600, currency: 'EUR' },
    },
  },
  {
    id: 'es-factura',
    dateOrder: 'DMY',
    currency: 'EUR',
    text: 'Ferretería López S.L.\nFactura simplificada\nFecha: 15 de enero de 2026\nTornillos 3,25\nTOTAL 12,75 €',
    expected: {
      correspondent: 'Ferretería López S.L.',
      date: '2026-01-15',
      total: { minor: 1275, currency: 'EUR' },
    },
  },
  {
    id: 'ch-rechnung',
    dateOrder: 'DMY',
    currency: 'CHF',
    text: "Alpen Garage AG\nRechnung\nDatum 04.03.2026\nService CHF 1'100.00\nTotal CHF 1'234.50",
    expected: {
      correspondent: 'Alpen Garage AG',
      date: '2026-03-04',
      total: { minor: 123450, currency: 'CHF' },
    },
  },
  {
    id: 'jp-receipt',
    dateOrder: 'YMD',
    currency: 'JPY',
    text: 'Sakura Books\n2026/04/03 14:05\nNovel ¥1,800\nMagazine ¥980\nTotal ¥2,780',
    expected: {
      correspondent: 'Sakura Books',
      date: '2026-04-03',
      total: { minor: 2780, currency: 'JPY' },
    },
  },
  {
    id: 'iso-date-statement',
    dateOrder: 'DMY',
    currency: 'EUR',
    text: 'Nordbank AG\nStatement 2026-03-31\nClosing balance EUR 1.234,56\nTotal 1.234,56',
    expected: {
      correspondent: 'Nordbank AG',
      date: '2026-03-31',
      total: { minor: 123456, currency: 'EUR' },
    },
  },
];
