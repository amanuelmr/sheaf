import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { PaperlessClient } from '@sheaf/paperless';
import { Forwarder } from './forwarder.ts';
import { paperlessTarget } from './paperless-target.ts';
import { createIngestServer } from './server.ts';
import { Storage } from './storage.ts';

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
const paperlessToken = process.env['PAPERLESS_TOKEN'];
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

if (paperlessUrl !== undefined && paperlessToken !== undefined) {
  const forwarder = new Forwarder(
    storage,
    paperlessTarget(
      new PaperlessClient({
        baseUrl: paperlessUrl,
        token: paperlessToken,
        fetch: (url, init) => fetch(url, init as RequestInit),
        formData: () => new FormData(),
      }),
    ),
    { now: () => Date.now(), jitter: () => Math.random() },
  );
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
} else {
  console.log('forwarding disabled (set PAPERLESS_URL and PAPERLESS_TOKEN to enable)');
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
