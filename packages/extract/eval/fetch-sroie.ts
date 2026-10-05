/**
 * Downloads the SROIE receipts into eval/cache/ (never committed: the original
 * dataset's terms are for research) and draws a fixed sample, whose ids are
 * committed so every run scores the same documents.
 *
 *   node --experimental-strip-types packages/extract/eval/fetch-sroie.ts
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromSroie, type SroieLine } from './golden.ts';

const DATASET = 'arvindrajan92/sroie_document_understanding';
const ROWS = 'https://datasets-server.huggingface.co/rows';
const PAGE = 100;
const SAMPLE = 50;
const SEED = 20261005;

const here = import.meta.dirname;
const cacheDir = join(here, 'cache');
const cacheFile = join(cacheDir, 'sroie.jsonl');
const sampleFile = join(here, 'sroie-sample.json');

interface Row {
  row_idx: number;
  row: { ocr: SroieLine[] };
}

async function fetchAll(): Promise<{ id: string; lines: SroieLine[] }[]> {
  const all: { id: string; lines: SroieLine[] }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${ROWS}?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${String(offset)}&length=${String(PAGE)}`;
    const response = await withRetries(() => fetch(url));
    if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
    const body = (await response.json()) as { rows: Row[]; num_rows_total: number };
    for (const { row_idx, row } of body.rows) all.push({ id: String(row_idx), lines: row.ocr });
    process.stdout.write(`\rfetched ${String(all.length)} of ${String(body.num_rows_total)}`);
    if (all.length >= body.num_rows_total || body.rows.length === 0) break;
  }
  process.stdout.write('\n');
  return all;
}

/** A public API on someone else's server: retry a few times before failing CI. */
async function withRetries(attempt: () => Promise<Response>): Promise<Response> {
  for (let tries = 1; ; tries++) {
    try {
      const response = await attempt();
      if (response.ok || tries === 4) return response;
    } catch (error) {
      if (tries === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * tries));
  }
}

/** mulberry32, so the sample is the same on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rows = await fetchAll();
mkdirSync(cacheDir, { recursive: true });
const golden = rows.map(({ id, lines }) => fromSroie(id, lines));
writeFileSync(cacheFile, golden.map((doc) => JSON.stringify(doc)).join('\n') + '\n');

if (!existsSync(sampleFile)) {
  // Only documents whose labels give all three fields, so a miss is the extractor's.
  const complete = golden.filter(
    (doc) => doc.expected.correspondent && doc.expected.date && doc.expected.total,
  );
  const random = seeded(SEED);
  const ids = [...complete]
    .map((doc) => ({ id: doc.id, key: random() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, SAMPLE)
    .map((entry) => entry.id)
    .sort();
  writeFileSync(sampleFile, JSON.stringify(ids, null, 2) + '\n');
  console.log(`sampled ${String(ids.length)} of ${String(complete.length)} complete receipts`);
} else {
  const ids = JSON.parse(readFileSync(sampleFile, 'utf8')) as string[];
  console.log(`kept the committed sample of ${String(ids.length)}`);
}
console.log(`wrote ${cacheFile}`);
