/**
 * Chaos run: many phones upload through a hostile network while the server is
 * killed outright, then every count is checked. Nothing may be lost or duplicated.
 *
 *   node --experimental-strip-types scripts/chaos.ts [--seed N] [--devices N] [--docs N]
 *
 * The phones are virtual but follow the real protocol: each pairs with a one-time
 * code, then PUTs each document to the address of its own hash. A lost reply is
 * resolved with HEAD before sending again, as the app does, and a refused connection
 * is retried with backoff. The server is a real process, started on a fresh data
 * directory and killed with SIGKILL three times while the uploads are in flight.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const SEED = flag('seed', Date.now() % 100_000);
const DEVICES = flag('devices', 20);
const DOCS = flag('docs', 25);
const KILLS = 3;
const PORT = 42_000 + (SEED % 1_000);
const TOKEN = `chaos-admin-${createHash('sha256').update(String(SEED)).digest('hex').slice(0, 24)}`;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'sheaf-chaos-'));

// mulberry32: the same seed replays the same faults.
let state = SEED >>> 0;
const random = (): number => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const counters = { attempts: 0, refused: 0, lostReplies: 0, serverDown: 0, heads: 0, kills: 0 };

// The server -------------------------------------------------------------------

let server: ChildProcess | null = null;

/**
 * Start the server and wait until it answers. A server that exits before it is
 * healthy (the port can take a moment to free after a kill) is simply started again.
 */
async function startServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', 'services/ingest/src/main.ts'],
      {
        env: { ...process.env, SHEAF_TOKEN: TOKEN, SHEAF_DATA_DIR: dataDir, PORT: String(PORT) },
        stdio: 'ignore',
      },
    );
    const state = { exited: false };
    child.once('exit', () => {
      state.exited = true;
    });
    const running = (): boolean => !state.exited;
    while (running() && Date.now() < deadline) {
      try {
        const response = await fetch(`${BASE}/v1/health`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        if (response.ok) {
          server = child;
          return;
        }
      } catch {
        // Not up yet.
      }
      await sleep(100);
    }
    if (running()) child.kill('SIGKILL');
    await sleep(200);
  }
  throw new Error('the server did not start within 30 s');
}

async function killServer(counted = true): Promise<void> {
  if (server === null) return;
  const dying = server;
  server = null;
  await new Promise<void>((resolve) => {
    dying.once('exit', () => resolve());
    dying.kill('SIGKILL');
  });
  if (counted) counters.kills += 1;
}

// A phone on a bad network -----------------------------------------------------

class Lost extends Error {}

/**
 * fetch through a hostile network: sometimes the request never leaves, sometimes the
 * server does the work and the reply is lost on the way back, which is the case
 * exactly-once delivery exists to survive.
 */
async function flaky(url: string, init: RequestInit): Promise<Response> {
  await sleep(Math.floor(random() * 30));
  counters.attempts += 1;
  if (random() < 0.1) {
    counters.refused += 1;
    throw new Lost('refused before sending');
  }
  const loseReply = random() < 0.1;
  const response = await fetch(url, init);
  if (loseReply) {
    await response.arrayBuffer();
    counters.lostReplies += 1;
    throw new Lost('reply lost after the server answered');
  }
  return response;
}

function documentFor(
  device: number,
  index: number,
): { bytes: Uint8Array; sha256: string; text: string } {
  const text = `CHAOS RECEIPT\nDevice ${String(device)} document ${String(index)}\nSeed ${String(SEED)}\nTOTAL ${(random() * 100).toFixed(2)}`;
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n% ${text.replace(/\n/g, ' ')}\n%%EOF\n`));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), text };
}

async function pair(device: number): Promise<string> {
  for (;;) {
    try {
      const created = await fetch(`${BASE}/v1/pairing-codes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { code } = (await created.json()) as { code: string };
      const paired = await fetch(`${BASE}/v1/pair`, {
        method: 'POST',
        body: JSON.stringify({ code, deviceName: `Chaos phone ${String(device)}` }),
      });
      if (paired.ok) return ((await paired.json()) as { token: string }).token;
    } catch {
      // The server may be mid-restart; try again.
    }
    await sleep(100);
  }
}

/** Deliver one document the way the app does, however long that takes. */
async function deliver(token: string, doc: ReturnType<typeof documentFor>): Promise<void> {
  const auth = { authorization: `Bearer ${token}` };
  let uncertain = false;
  for (let attempt = 1; ; attempt++) {
    try {
      // After a reply was lost, ask before resending: it may already be there.
      if (uncertain) {
        counters.heads += 1;
        const head = await flaky(`${BASE}/v1/documents/${doc.sha256}`, {
          method: 'HEAD',
          headers: auth,
        });
        if (head.status === 200) break;
        uncertain = false;
      }
      const put = await flaky(`${BASE}/v1/documents/${doc.sha256}`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/pdf' },
        body: doc.bytes,
      });
      if (put.status === 200 || put.status === 201) break;
      throw new Error(`PUT answered ${String(put.status)}`);
    } catch (error) {
      if (error instanceof Lost && error.message.startsWith('reply lost')) uncertain = true;
      else if (!(error instanceof Lost)) {
        counters.serverDown += 1;
        uncertain = true;
      }
      await sleep(Math.min(1_000, 20 * 2 ** Math.min(attempt, 6)) * (0.5 + random() / 2));
    }
  }
  // Then its text, which is idempotent by document and source.
  for (;;) {
    try {
      const put = await flaky(`${BASE}/v1/documents/${doc.sha256}/text`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'edge', engine: 'chaos', text: doc.text }),
      });
      if (put.status === 204) return;
    } catch {
      // Lost or down: send again; the same text twice changes nothing.
    }
    await sleep(50);
  }
}

// The run ----------------------------------------------------------------------

const started = Date.now();
await startServer();
const tokens: string[] = [];
for (let d = 0; d < DEVICES; d++) tokens.push(await pair(d));
const documents = tokens.flatMap((_, d) =>
  Array.from({ length: DOCS }, (_, i) => documentFor(d, i)),
);

// An object, so the killer sees the uploads finish.
const run = { uploading: true, delivered: 0 };
const stillUploading = (): boolean => run.uploading;
const killer = (async () => {
  for (let k = 0; k < KILLS && stillUploading(); k++) {
    await sleep(300 + Math.floor(random() * 900));
    if (!stillUploading()) break;
    await killServer();
    await sleep(200);
    await startServer();
  }
})();

// A run that cannot finish says so, rather than retrying for ever.
killer.catch((error: unknown) => {
  console.error(`\n  FAILED: ${String(error)}`);
  process.exit(1);
});
const watchdog = setTimeout(() => {
  console.error(`\n  FAILED: still running after 5 minutes (${String(run.delivered)} delivered)`);
  process.exit(1);
}, 300_000);
const progress = setInterval(() => {
  console.log(`  … delivered ${String(run.delivered)} of ${String(DEVICES * DOCS)}`);
}, 5_000);

await Promise.all(
  tokens.map(async (token, d) => {
    for (const doc of documents.slice(d * DOCS, (d + 1) * DOCS)) {
      await deliver(token, doc);
      run.delivered += 1;
    }
  }),
);
clearInterval(progress);
clearTimeout(watchdog);
run.uploading = false;
await killer;

// Let the job runner read every document, then check everything.
const expected = DEVICES * DOCS;
const admin = { authorization: `Bearer ${TOKEN}` };
let extracted = 0;
for (let i = 0; i < 120 && extracted < expected; i++) {
  const metrics = await (await fetch(`${BASE}/metrics`, { headers: admin })).text();
  extracted = Number(/sheaf_jobs\{step="extract",state="done"\} (\d+)/.exec(metrics)?.[1] ?? 0);
  if (extracted < expected) await sleep(500);
}
const health = (await (await fetch(`${BASE}/v1/health`, { headers: admin })).json()) as {
  documents: number;
};
let missing = 0;
for (const doc of documents) {
  const head = await fetch(`${BASE}/v1/documents/${doc.sha256}`, {
    method: 'HEAD',
    headers: admin,
  });
  if (head.status !== 200) missing += 1;
}
const objects = readdirSync(join(dataDir, 'objects'), { recursive: true }).filter((f) =>
  String(f).endsWith('.pdf'),
).length;
await killServer(false);

const duplicated = Math.max(0, health.documents - expected) + Math.max(0, objects - expected);
const ok =
  missing === 0 && duplicated === 0 && health.documents === expected && extracted === expected;

const row = (label: string, value: string | number) =>
  console.log(`  ${label.padEnd(40)} ${String(value)}`);
console.log(`\nSheaf chaos run, seed ${String(SEED)}`);
row('phones (paired with one-time codes)', DEVICES);
row('documents sent', expected);
row('requests made', counters.attempts);
row('refused before sending', counters.refused);
row('replies lost after the server stored', counters.lostReplies);
row('times the server was unreachable', counters.serverDown);
row('HEAD checks before resending', counters.heads);
row('server killed with SIGKILL', counters.kills);
row('documents on the server', health.documents);
row('files in object storage', objects);
row('documents read by extraction', extracted);
row('lost', missing);
row('duplicated', duplicated);
row('wall time', `${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(ok ? '\n  OK: nothing lost, nothing duplicated.\n' : '\n  FAILED\n');
process.exit(ok ? 0 : 1);
