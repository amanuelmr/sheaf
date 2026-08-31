import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { PaperlessClient } from '@sheaf/paperless';
import { Forwarder } from './forwarder.ts';
import { paperlessTarget } from './paperless-target.ts';
import { paperlessSuggestionSource } from './paperless-suggestions.ts';
import { Retention } from './retention.ts';
import { createIngestServer } from './server.ts';
import { Storage } from './storage.ts';
import { SuggestionFetcher } from './suggestion-fetcher.ts';

/**
 * Free disk space held by documents Paperless has confirmed it already has.
 *
 * Unset by default -- see retention.ts for why keeping every copy is the right
 * starting point. A number here is an explicit statement that Paperless is trusted
 * enough to be the only copy of documents older than this.
 */
function retentionMsFromEnv(): number | null {
  const raw = process.env['SHEAF_RETENTION_DAYS'];
  if (raw === undefined || raw === '') return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(
      `SHEAF_RETENTION_DAYS must be a positive number of days, got "${raw}" — ignoring it.`,
    );
    return null;
  }
  return days * 24 * 60 * 60 * 1000;
}

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

const server = createIngestServer({
  storage,
  token,
  now: () => Date.now(),
  ...(forwardingTo === undefined ? {} : { forwardingTo }),
});

if (paperlessUrl !== undefined && paperlessToken !== undefined && paperlessToken !== null) {
  // Shared: forwarding and suggestion-fetching are two different questions asked
  // of the same server, not two servers.
  const paperlessClient = new PaperlessClient({
    baseUrl: paperlessUrl,
    token: paperlessToken,
    fetch: (url, init) => fetch(url, init as RequestInit),
    formData: () => new FormData(),
  });

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

  const suggestions = new SuggestionFetcher(
    storage,
    paperlessSuggestionSource(paperlessClient, () => Date.now()),
    { now: () => Date.now(), jitter: () => Math.random() },
  );
  let fetchingSuggestions = false;
  setInterval(() => {
    if (fetchingSuggestions) return;
    fetchingSuggestions = true;
    void suggestions
      .tick()
      .catch((error: unknown) => console.error('fetching suggestions failed:', String(error)))
      .finally(() => {
        fetchingSuggestions = false;
      });
  }, 5_000);

  const retentionMs = retentionMsFromEnv();
  if (retentionMs !== null) {
    const retention = new Retention(storage, retentionMs, { now: () => Date.now() });
    let releasing = false;
    setInterval(() => {
      if (releasing) return;
      releasing = true;
      void retention
        .tick()
        .catch((error: unknown) => console.error('retention sweep failed:', String(error)))
        .finally(() => {
          releasing = false;
        });
    }, 60_000);
    console.log(
      `retention: freeing bytes ${String(retentionMs / 86_400_000)} day(s) after forwarding`,
    );
  }
} else {
  console.log(
    paperlessUrl === undefined
      ? 'forwarding disabled (no PAPERLESS_URL) — documents are stored but not searchable'
      : 'forwarding disabled — could not get a token from ' + paperlessUrl,
  );
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
