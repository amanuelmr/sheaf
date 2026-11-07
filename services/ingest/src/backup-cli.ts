/**
 * `pnpm --filter @sheaf/ingest export <dir>` / `import <dir>`.
 *
 * Works on the same data directory as the server (SHEAF_DATA_DIR). Stop the server
 * first: two processes writing one SQLite database is asking for a locked-database
 * error halfway through.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { exportTo, importFrom } from './backup.ts';
import { CustomFields } from './custom-fields.ts';
import { filenameFormatProblem } from './filename.ts';
import { Labels } from './labels.ts';
import { Settings } from './settings.ts';
import { Storage } from './storage.ts';
import { SavedViews } from './views.ts';

const [command, dir] = process.argv.slice(2);
if ((command !== 'export' && command !== 'import') || dir === undefined) {
  console.error('usage: backup-cli.ts export|import <directory>');
  process.exit(2);
}

const dataDir = process.env['SHEAF_DATA_DIR'] ?? join(process.cwd(), '.sheaf-data');
mkdirSync(dataDir, { recursive: true });
const driver = nodeSqliteDriver(join(dataDir, 'ingest.db'));
const storage = await Storage.open({ driver, objectsDir: join(dataDir, 'objects') });
// The format saved from the web app, unless the environment names one for this run.
const format =
  process.env['SHEAF_FILENAME_FORMAT'] ??
  (await Settings.open(driver, {})).current().filenameFormat;
const problem = filenameFormatProblem(format);
if (problem !== null) {
  console.error(`SHEAF_FILENAME_FORMAT: ${problem}`);
  process.exit(2);
}
const parts = {
  driver,
  storage,
  labels: new Labels(driver, storage),
  fields: new CustomFields(driver, storage),
  views: new SavedViews(driver),
};

if (command === 'export') {
  const report = await exportTo(dir, parts, format, Date.now());
  console.log(
    `exported ${String(report.documents)} documents to ${dir}` +
      (report.withoutFile > 0
        ? ` (${String(report.withoutFile)} without their file: released)`
        : ''),
  );
} else {
  const report = await importFrom(dir, parts, Date.now());
  console.log(
    `imported ${String(report.imported)} documents; ${String(report.alreadyHere)} were already here`,
  );
  for (const line of report.problems) console.log(`  ! ${line}`);
  if (report.problems.length > 0) process.exitCode = 1;
}
