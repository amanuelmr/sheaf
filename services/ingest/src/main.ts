import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { PaperlessClient } from '@sheaf/paperless';
import type { ReconciliationProbe } from '@sheaf/protocol';
import { paperlessArchiveSource } from './paperless-browse.ts';
import { Forwarder } from './forwarder.ts';
import { JobRunner, type Step } from './jobs.ts';
import { extractStep } from './steps/extract.ts';
import { ocrStep } from './steps/ocr.ts';
import { paperlessTarget } from './paperless-target.ts';
import { paperlessSuggestionSource } from './paperless-suggestions.ts';
import { paperlessVocabulary } from './paperless-vocabulary.ts';
import { Retention } from './retention.ts';
import { Devices } from './devices.ts';
import { archiveFromEnv, extractionFromEnv, retentionFromEnv } from './config.ts';
import { nativeArchiveSource } from './native-archive.ts';
import { createIngestServer } from './server.ts';
import { PRIMARY_CONNECTOR, Storage } from './storage.ts';
import { SuggestionFetcher } from './suggestion-fetcher.ts';

/**
 * Entry point. Configuration is environment only — nothing about where documents
 * live or which token is accepted belongs in a file that might get committed.
 */
const token = process.env['SHEAF_TOKEN'];
if (token === undefined || token.length < 16) {
  // Refuse to start rather than come up with a guessable token: this server holds
  // documents, and a weak default would be the worst possible one.
  console.error('SHEAF_TOKEN must be set to at least 16 characters.');
  console.error(
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

const dataDir = process.env['SHEAF_DATA_DIR'] ?? join(process.cwd(), '.sheaf-data');
const port = Number(process.env['PORT'] ?? 8787);

// SQLite will not create the directory it is asked to open a file in, so first
// run fails with a bare "unable to open database file" unless we make it first.
mkdirSync(dataDir, { recursive: true });

const driver = nodeSqliteDriver(join(dataDir, 'ingest.db'));
const storage = await Storage.open({ driver, objectsDir: join(dataDir, 'objects') });

/**
 * Forwarding is opt-in. Without it this server stores documents and nothing more,
 * which is honest but not very useful -- a stored PDF you cannot search is worse
 * than a photo in your camera roll. Point it at a Paperless-ngx and the documents
 * become searchable text.
 */
const paperlessUrl = process.env['PAPERLESS_URL'];

// Checked before anything waits on Paperless, so a bad setting fails in seconds
// rather than after a five-minute wait for a token. See config.ts.
const retentionSetting = retentionFromEnv(
  process.env,
  paperlessUrl === undefined ? [] : [PRIMARY_CONNECTOR],
);
if (retentionSetting.kind === 'invalid') {
  console.error(retentionSetting.message);
  process.exit(1);
}
const retention = retentionSetting.kind === 'on' ? retentionSetting.config : null;

const archiveChoice = archiveFromEnv(process.env, paperlessUrl !== undefined);
if (archiveChoice.kind === 'invalid') {
  console.error(archiveChoice.message);
  process.exit(1);
}

const extraction = extractionFromEnv(process.env, paperlessUrl !== undefined, (url, init) =>
  fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(120_000) }),
);
if (extraction.kind === 'invalid') {
  console.error(extraction.message);
  process.exit(1);
}

/**
 * Get a token for the downstream system.
 *
 * A token can only be issued once Paperless has finished its first boot, which is
 * minutes after `docker compose up` returns. Requiring someone to wait, fetch a
 * token by hand and restart is the sort of setup step that quietly decides whether
 * a project gets used, so the server does it itself and keeps trying until the
 * other container is ready.
 */
async function resolveToken(baseUrl: string): Promise<string | null> {
  const explicit = process.env['PAPERLESS_TOKEN'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const username = process.env['PAPERLESS_USER'];
  const password = process.env['PAPERLESS_PASSWORD'];
  if (username === undefined || password === undefined) return null;

  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        const body = (await response.json()) as { token?: string };
        if (typeof body.token === 'string') return body.token;
      }
    } catch {
      // Not up yet. Waiting is the expected case, not an error worth reporting.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}

const paperlessToken = paperlessUrl === undefined ? undefined : await resolveToken(paperlessUrl);
const forwardingTo =
  paperlessUrl === undefined || paperlessToken === undefined
    ? undefined
    : paperlessUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// Shared: forwarding, suggestion-fetching and the reconciliation probe are three
// different questions asked of the same server, not three servers.
const paperlessClient =
  paperlessUrl !== undefined && paperlessToken !== undefined && paperlessToken !== null
    ? new PaperlessClient({
        baseUrl: paperlessUrl,
        token: paperlessToken,
        fetch: (url, init) => fetch(url, init as RequestInit),
        formData: () => new FormData(),
      })
    : null;

// Diagnostic only -- read live by the health route, and correctness never depends
// on it. `null` until the one-time probe below resolves.
let reconciliationProbe: ReconciliationProbe | null = null;

// The vocabulary cache is shared between everything that resolves an id to a
// name -- suggestions and the archive both need it, and neither should pay for a
// fetch the other already made.
const vocabulary =
  paperlessClient === null ? null : paperlessVocabulary(paperlessClient, () => Date.now());
// The phone's library browses our own catalog by default (ADR 0007). Paperless's
// archive is used only when chosen, and is absent, so routes answer "disabled",
// if its token could not be had.
const archiveSource =
  archiveChoice.kind === 'native'
    ? nativeArchiveSource(storage)
    : paperlessClient === null || vocabulary === null
      ? null
      : paperlessArchiveSource(paperlessClient, vocabulary);
console.log(
  `archive: /v1/archive browses ${archiveChoice.kind === 'native' ? 'this server' : 'Paperless'}`,
);

const server = createIngestServer({
  storage,
  token,
  // Paired phones (ADR 0008). SHEAF_TOKEN stays the admin's, and still uploads.
  devices: new Devices(driver, { now: () => Date.now() }),
  now: () => Date.now(),
  ...(forwardingTo === undefined ? {} : { forwardingTo }),
  ...(paperlessClient === null ? {} : { reconciliation: () => reconciliationProbe }),
  ...(archiveSource === null ? {} : { archive: archiveSource }),
  ...(retention === null ? {} : { retentionDays: retention.ms / 86_400_000 }),
});

if (paperlessClient !== null && vocabulary !== null) {
  const forwarder = new Forwarder(storage, paperlessTarget(paperlessClient), {
    now: () => Date.now(),
    jitter: () => Math.random(),
  });
  // Overlapping passes are skipped rather than queued; a slow downstream should
  // not turn into a pile-up of concurrent uploads.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void forwarder
      .tick()
      .catch((error: unknown) => console.error('forwarding failed:', String(error)))
      .finally(() => {
        running = false;
      });
  }, 5_000);
  console.log(`forwarding to ${forwardingTo ?? 'unknown'}`);

  // Paperless's own suggestions, only when chosen instead of reading documents here.
  const suggestions =
    extraction.kind !== 'paperless'
      ? null
      : new SuggestionFetcher(storage, paperlessSuggestionSource(paperlessClient, vocabulary), {
          now: () => Date.now(),
          jitter: () => Math.random(),
        });
  let fetchingSuggestions = false;
  setInterval(() => {
    if (suggestions === null || fetchingSuggestions) return;
    fetchingSuggestions = true;
    void suggestions
      .tick()
      .catch((error: unknown) => console.error('fetching suggestions failed:', String(error)))
      .finally(() => {
        fetchingSuggestions = false;
      });
  }, 5_000);

  if (retention !== null) {
    const sweeper = new Retention(storage, retention.ms, retention.connector, {
      now: () => Date.now(),
    });
    let releasing = false;
    setInterval(() => {
      if (releasing) return;
      releasing = true;
      void sweeper
        .tick()
        .catch((error: unknown) => console.error('retention sweep failed:', String(error)))
        .finally(() => {
          releasing = false;
        });
    }, 60_000);
    console.log(
      `retention: freeing bytes ${String(retention.ms / 86_400_000)} day(s) after ${retention.connector} confirms`,
    );
  }

  // One-shot, in the background: this never blocks startup on a request to a
  // server that might not even be up yet, and correctness never depends on the
  // answer -- crash recovery works either way, just at the cost of a redundant
  // upload if the filter turns out not to be supported. See ADR 0004. A failed
  // probe leaves reconciliationProbe null, which the health route already treats
  // as "no answer yet".
  void paperlessClient.probeReconciliation().then((result) => {
    if (result.ok) reconciliationProbe = result.value;
  });
} else {
  console.log(
    paperlessUrl === undefined
      ? 'no connectors: documents are stored and searched here, and sent nowhere else'
      : 'forwarding disabled — could not get a token from ' + paperlessUrl,
  );
}
/**
 * Work each stored document goes through after it is safe: reading its text,
 * extracting its details. Empty until those steps exist; the loop only starts once
 * there is something for it to do.
 */
const steps: Step[] = [];

// Reading each document's details (ADR 0010), unless Paperless's suggestions were chosen.
if (extraction.kind === 'native') {
  steps.push(
    extractStep(storage, {
      extractor: extraction.extractor,
      dateOrder: extraction.dateOrder,
      defaultCurrency: extraction.defaultCurrency,
      graceMs: 120_000,
    }),
  );
  console.log(
    `extraction: ${extraction.extractor.name}` +
      (extraction.sendsTextAway ? ' (document text is sent to the provider)' : ''),
  );
}

// Server-side OCR, only when the sidecar is there (compose.ocr.yml). ADR 0009.
const ocrUrl = process.env['SHEAF_OCR_URL'];
if (ocrUrl !== undefined && ocrUrl !== '') {
  steps.push(
    ocrStep(storage, {
      url: ocrUrl,
      // Generous: a long scan on a small machine takes minutes, and the sidecar
      // gives up on its own at five.
      fetch: (url, body) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/pdf' },
          body,
          signal: AbortSignal.timeout(330_000),
        }),
      graceMs: 120_000,
    }),
  );
}
if (steps.length > 0) {
  const jobs = new JobRunner(driver, storage, steps, {
    now: () => Date.now(),
    jitter: () => Math.random(),
  });
  let runningJobs = false;
  setInterval(() => {
    if (runningJobs) return;
    runningJobs = true;
    void jobs
      .tick()
      .catch((error: unknown) => console.error('a job crashed:', String(error)))
      .finally(() => {
        runningJobs = false;
      });
  }, 2_000);
  console.log(`jobs: ${steps.map((step) => step.name).join(', ')}`);
}

server.listen(port, () => {
  console.log(`sheaf-ingest listening on http://localhost:${port}`);
  console.log(`documents: ${dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      driver.close();
      process.exit(0);
    });
  });
}
