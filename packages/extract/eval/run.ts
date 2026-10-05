/**
 * The extraction eval (ADR 0010): every configured extractor over the same golden
 * documents, scored field by field, with cost and latency.
 *
 *   pnpm --filter @sheaf/extract eval                  live where configured
 *   pnpm --filter @sheaf/extract eval -- --record      live, and save each answer
 *   pnpm --filter @sheaf/extract eval -- --replay      saved answers only (CI)
 *   ... --check             fail if any field drops more than 2 points below baseline
 *   ... --update-baseline   accept these results as the new baseline
 *   ... --dev               score the receipts outside the test sample instead
 *
 * Tune against --dev, never against the test sample: rules fitted to the documents
 * they are scored on report flattering numbers. --dev writes no report, results or
 * baseline.
 *
 * The heuristic extractor always runs. Claude runs with ANTHROPIC_API_KEY (or its
 * recordings, in replay); Ollama with SHEAF_OLLAMA_URL and SHEAF_OLLAMA_MODEL.
 * Writes report.md and results.json beside this file.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '@sheaf/http';
import { claudeExtractor, DEFAULT_CLAUDE_MODEL } from '../src/claude.ts';
import type { Extractor } from '../src/extractor.ts';
import { heuristicExtractor } from '../src/heuristic.ts';
import { ollamaExtractor } from '../src/ollama.ts';
import { SROIE_TODAY, type GoldenDocument } from './golden.ts';
import { recordingFetch, type Mode } from './recorder.ts';
import {
  aggregate,
  judge,
  percentile,
  SCORED_FIELDS,
  type FieldScore,
  type Verdict,
} from './score.ts';

const here = import.meta.dirname;
const args = new Set(process.argv.slice(2));
const mode: Mode = args.has('--replay') ? 'replay' : args.has('--record') ? 'record' : 'live';
const dev = args.has('--dev');
const ALLOWED_DROP = 2;

interface ProviderResult {
  readonly model: string;
  readonly documents: number;
  readonly failures: number;
  readonly fields: Readonly<Record<string, FieldScore>>;
  readonly costPerDocUsd: number | null;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

function golden(): GoldenDocument[] {
  const cache = join(here, 'cache', 'sroie.jsonl');
  if (!existsSync(cache)) {
    throw new Error('No golden data. Run `pnpm --filter @sheaf/extract eval:fetch` first.');
  }
  const ids = new Set(
    JSON.parse(readFileSync(join(here, 'sroie-sample.json'), 'utf8')) as string[],
  );
  return readFileSync(cache, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as GoldenDocument)
    .filter((doc) =>
      dev
        ? !ids.has(doc.id) &&
          doc.expected.correspondent !== undefined &&
          doc.expected.date !== undefined &&
          doc.expected.total !== undefined
        : ids.has(doc.id),
    );
}

const liveFetch: FetchLike = (url, init) =>
  fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(120_000) });

function providers(): { extractor: Extractor; latency: () => number }[] {
  const list: { extractor: Extractor; latency: () => number }[] = [];
  const wrap = (name: string) => recordingFetch(join(here, 'recorded', name), mode, liveFetch);

  // The heuristic needs no network; its latency is measured around the call.
  list.push({ extractor: heuristicExtractor(), latency: () => -1 });

  const claudeRecordings = join(here, 'recorded', 'claude');
  const key = process.env['ANTHROPIC_API_KEY'];
  if ((mode !== 'replay' && key) || (mode === 'replay' && existsSync(claudeRecordings))) {
    const recorder = wrap('claude');
    const model = process.env['SHEAF_CLAUDE_MODEL'] || DEFAULT_CLAUDE_MODEL;
    list.push({
      extractor: claudeExtractor({ apiKey: key ?? 'replay', fetch: recorder.fetch, model }),
      latency: () => recorder.lastLatencyMs(),
    });
  }

  const ollamaUrl = process.env['SHEAF_OLLAMA_URL'];
  const ollamaModel = process.env['SHEAF_OLLAMA_MODEL'];
  const ollamaRecordings = join(here, 'recorded', 'ollama');
  if (
    (mode !== 'replay' && ollamaUrl && ollamaModel) ||
    (mode === 'replay' && existsSync(ollamaRecordings) && readdirSync(ollamaRecordings).length > 0)
  ) {
    const recorder = wrap('ollama');
    list.push({
      extractor: ollamaExtractor({
        url: ollamaUrl ?? 'http://replay',
        model: ollamaModel ?? 'replay',
        fetch: recorder.fetch,
      }),
      latency: () => recorder.lastLatencyMs(),
    });
  }
  return list;
}

async function evaluate(
  extractor: Extractor,
  latency: () => number,
  documents: readonly GoldenDocument[],
): Promise<{ result: ProviderResult; verdicts: (Verdict & { id: string })[] }> {
  const verdicts: (Verdict & { id: string })[] = [];
  const latencies: number[] = [];
  let cost = 0;
  let costKnown = true;
  let failures = 0;
  let model: string = extractor.name;

  for (const doc of documents) {
    const started = performance.now();
    const outcome = await extractor.extract({
      text: doc.text,
      vocabulary: { correspondents: [], documentTypes: [], tags: [] },
      today: SROIE_TODAY,
      dateOrder: 'DMY',
      defaultCurrency: doc.currency,
    });
    const measured = latency();
    latencies.push(measured >= 0 ? measured : performance.now() - started);
    if (!outcome.ok) {
      failures += 1;
      verdicts.push(...judge(doc.expected, {}).map((v) => ({ ...v, id: doc.id })));
      continue;
    }
    model = outcome.value.model;
    if (outcome.value.usage.costUsd === null) costKnown = false;
    else cost += outcome.value.usage.costUsd;
    verdicts.push(...judge(doc.expected, outcome.value.fields).map((v) => ({ ...v, id: doc.id })));
  }

  return {
    verdicts,
    result: {
      model,
      documents: documents.length,
      failures,
      fields: aggregate(verdicts),
      costPerDocUsd: costKnown ? cost / documents.length : null,
      latencyP50Ms: Math.round(percentile(latencies, 50) * 10) / 10,
      latencyP95Ms: Math.round(percentile(latencies, 95) * 10) / 10,
    },
  };
}

function report(
  results: Readonly<Record<string, ProviderResult>>,
  misses: Readonly<Record<string, readonly (Verdict & { id: string })[]>>,
  sample: number,
): string {
  const head = ['Extractor', 'Model', ...SCORED_FIELDS.map(label), 'Cost / doc', 'p50', 'p95'];
  const rows = Object.entries(results).map(([name, r]) => [
    name,
    `\`${r.model}\``,
    ...SCORED_FIELDS.map(
      (f) => `${r.fields[f]!.accuracy.toFixed(1)}% (${r.fields[f]!.coverage.toFixed(0)}% answered)`,
    ),
    r.costPerDocUsd === null ? 'unknown' : `$${r.costPerDocUsd.toFixed(5)}`,
    `${r.latencyP50Ms} ms`,
    `${r.latencyP95Ms} ms`,
  ]);
  const table = [head, head.map(() => '---'), ...rows]
    .map((r) => `| ${r.join(' | ')} |`)
    .join('\n');

  const worst = Object.entries(misses)
    .map(([name, list]) => {
      const lines = SCORED_FIELDS.filter((f) => f !== 'correspondentFuzzy').flatMap((field) =>
        list
          .filter((v) => v.field === field && !v.correct)
          .slice(0, 5)
          .map((v) => `| ${field} | ${v.id} | ${escape(v.expected)} | ${escape(v.got)} |`),
      );
      return lines.length === 0
        ? ''
        : `### ${name}: first misses\n\n| Field | Document | Expected | Got |\n| --- | --- | --- | --- |\n${lines.join('\n')}\n`;
    })
    .join('\n');

  return `# Extraction eval

Generated by \`packages/extract/eval/run.ts\` (${mode} mode). Do not edit by hand.

**Data:** a fixed sample of ${String(sample)} receipts from SROIE (ICDAR 2019), Malaysian
receipts from 2017–2018, read from the dataset's own OCR lines. Expected values come
from its labels, through the same normalisers the extractors use. This is a small
sample of one kind of document: read the numbers as a comparison between extractors,
not as accuracy on your own paperwork.

**Fields:** accuracy is exact after normalisation; a missing answer counts as wrong.
\`correspondent ~\` accepts a name sharing most of its words with the label (token F1 ≥
0.8), since SROIE labels long legal names.

${table}

${worst}`;
}

function label(field: string): string {
  return field === 'correspondentFuzzy' ? 'correspondent ~' : field;
}

function escape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 60);
}

const documents = golden();
const results: Record<string, ProviderResult> = {};
const misses: Record<string, (Verdict & { id: string })[]> = {};
for (const { extractor, latency } of providers()) {
  process.stdout.write(`${extractor.name}… `);
  const { result, verdicts } = await evaluate(extractor, latency, documents);
  results[extractor.name] = result;
  misses[extractor.name] = verdicts;
  console.log(
    SCORED_FIELDS.map((f) => `${label(f)} ${result.fields[f]!.accuracy.toFixed(1)}%`).join(', '),
  );
}

if (dev) {
  for (const [name, list] of Object.entries(misses)) {
    const wrong = list.filter((v) => !v.correct && v.field === 'total').slice(0, 15);
    console.log(`\n${name}, dev set (${String(documents.length)} receipts), first total misses:`);
    for (const v of wrong) console.log(`  ${v.id}: expected ${v.expected}, got ${v.got}`);
  }
  process.exit(0);
}

writeFileSync(
  join(here, 'results.json'),
  JSON.stringify({ sample: documents.length, results }, null, 2) + '\n',
);
writeFileSync(join(here, 'report.md'), report(results, misses, documents.length));

const baselineFile = join(here, 'baseline.json');
if (args.has('--update-baseline')) {
  const baseline = Object.fromEntries(
    Object.entries(results).map(([name, r]) => [
      name,
      Object.fromEntries(SCORED_FIELDS.map((f) => [f, r.fields[f]!.accuracy])),
    ]),
  );
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
  console.log('baseline updated');
}

if (args.has('--check')) {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<
    string,
    Record<string, number>
  >;
  const drops: string[] = [];
  for (const [name, fields] of Object.entries(baseline)) {
    const now = results[name];
    if (now === undefined) {
      drops.push(`${name}: not run (missing recordings or configuration?)`);
      continue;
    }
    for (const [field, before] of Object.entries(fields)) {
      const after = now.fields[field]!.accuracy;
      if (after < before - ALLOWED_DROP)
        drops.push(`${name} ${field}: ${String(before)}% → ${String(after)}%`);
    }
  }
  if (drops.length > 0) {
    console.error(`Extraction got worse:\n  ${drops.join('\n  ')}`);
    process.exit(1);
  }
  console.log('no field dropped more than 2 points below the baseline');
}
