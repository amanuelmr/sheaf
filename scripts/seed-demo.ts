/**
 * Fills a Sheaf server with synthetic documents, for demos and screenshots: nothing
 * real ever has to appear in either.
 *
 *   SHEAF_URL=http://localhost:8787 SHEAF_TOKEN=... node --experimental-strip-types scripts/seed-demo.ts
 *
 * Each document is a real one-page PDF with its text on it, sent the way the phone
 * sends one: the PDF to its own address, then its text. The server then reads its
 * details like any other.
 */
import { createHash } from 'node:crypto';

const url = (process.env['SHEAF_URL'] ?? 'http://localhost:8787').replace(/\/+$/, '');
const token = process.env['SHEAF_TOKEN'];
if (token === undefined) {
  console.error('Set SHEAF_TOKEN to the server’s admin token.');
  process.exit(1);
}
const COUNT = Number(process.env['SEED_COUNT'] ?? 40);

/** Each merchant with what it plausibly sells, so a demo never bills for the wrong thing. */
const MERCHANTS = [
  ['Cinema City', 'Receipt', ['Tickets', 'Popcorn', 'Soda']],
  ['Green Grocer', 'Receipt', ['Bread', 'Apples', 'Coffee', 'Milk']],
  ['City Power', 'Bill', ['Electricity', 'Standing charge']],
  ['Northside Pharmacy', 'Receipt', ['Plasters', 'Vitamins', 'Toothpaste']],
  ['Harbour Hardware', 'Invoice', ['Paint', 'Batteries', 'Screws', 'Brushes']],
  ['Blue Line Taxis', 'Receipt', ['Fare', 'Waiting time']],
  ['Aqua Water Board', 'Bill', ['Water supply', 'Sewerage']],
  ['Lantern Books', 'Receipt', ['Notebook', 'Paperback', 'Pens']],
] as const;

/** A small deterministic generator, so every run seeds the same demo. */
let state = 42;
const random = (): number => {
  state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
  return state / 2_147_483_648;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

function receipt(i: number): { lines: string[] } {
  const [merchant, kind, stock] = pick(MERCHANTS);
  const day = new Date(Date.UTC(2026, 8, 1) + Math.floor(random() * 34) * 86_400_000);
  const date = `${String(day.getUTCDate()).padStart(2, '0')}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${String(day.getUTCFullYear())}`;
  const items = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
    name: pick(stock),
    cents: 150 + Math.floor(random() * 4_000),
  }));
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  const paid = Math.ceil(total / 1_000) * 1_000;
  const money = (cents: number) => (cents / 100).toFixed(2);
  return {
    lines: [
      merchant.toUpperCase(),
      kind === 'Invoice' ? 'TAX INVOICE' : kind === 'Bill' ? 'STATEMENT OF ACCOUNT' : 'RECEIPT',
      `Date: ${date}`,
      `No. ${String(10_000 + i)}`,
      '',
      ...items.map((item) => `${item.name.padEnd(24)}${money(item.cents).padStart(10)}`),
      '',
      `TOTAL EUR${money(total).padStart(27)}`,
      ...(kind === 'Receipt'
        ? [`CASH${money(paid).padStart(30)}`, `CHANGE${money(paid - total).padStart(28)}`]
        : []),
      '',
      'Thank you',
    ],
  };
}

/** A one-page PDF with the given lines in a monospace font. Small, valid, readable. */
function pdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    'BT /F1 11 Tf 13 TL 60 780 Td',
    ...lines.map((line) => `(${escape(line)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out));
}

const headers = { authorization: `Bearer ${token}` };
let stored = 0;
for (let i = 0; i < COUNT; i++) {
  const { lines } = receipt(i);
  const bytes = pdf(lines);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const put = await fetch(`${url}/v1/documents/${sha256}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/pdf', 'x-sheaf-page-count': '1' },
    body: bytes,
  });
  if (!put.ok && put.status !== 200) throw new Error(`PUT failed: ${String(put.status)}`);
  const text = await fetch(`${url}/v1/documents/${sha256}/text`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'edge', engine: 'demo', text: lines.join('\n') }),
  });
  if (!text.ok) throw new Error(`text failed: ${String(text.status)}`);
  stored += put.status === 201 ? 1 : 0;
}
console.log(`seeded ${String(COUNT)} documents (${String(stored)} new) into ${url}`);
