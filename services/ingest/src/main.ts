import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { createIngestServer } from './server';
import { Storage } from './storage';

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

const driver = nodeSqliteDriver(join(dataDir, 'ingest.db'));
const storage = await Storage.open({ driver, objectsDir: join(dataDir, 'objects') });

const server = createIngestServer({ storage, token, now: () => Date.now() });
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
