import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { PaperlessClient } from '@sheaf/paperless';
import type { DateOrderSetting, ReconciliationProbe } from '@sheaf/protocol';
import { paperlessArchiveSource } from './paperless-browse.ts';
import { Forwarder, type Connector } from './forwarder.ts';
import { folderTarget } from './folder-target.ts';
import { webdavTarget } from './webdav-target.ts';
import { JobRunner, type Step } from './jobs.ts';
import { extractStep } from './steps/extract.ts';
import { ocrStep } from './steps/ocr.ts';
import { paperlessTarget } from './paperless-target.ts';
import { paperlessSuggestionSource } from './paperless-suggestions.ts';
import { paperlessVocabulary } from './paperless-vocabulary.ts';
import { Retention } from './retention.ts';
import { CustomFields } from './custom-fields.ts';
import { Labels } from './labels.ts';
import { Rules } from './rules.ts';
import { BulkEditor } from './bulk.ts';
import { ConsumeFolder } from './consume.ts';
import { MailFetcher } from './mail.ts';
import { connect as tlsConnect } from 'node:tls';
import { NearDuplicates } from './near-duplicates.ts';
import { ShareLinks } from './share-links.ts';
import { Workflows } from './workflows.ts';
import { sendMail, type OutgoingMail } from './smtp.ts';
import { EMAIL_PATTERN } from '@sheaf/protocol';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { Users } from './users.ts';
import { AuditLog } from './audit.ts';
import { DocumentEdits } from './document-edits.ts';
import { Settings } from './settings.ts';
import { Sso } from './sso.ts';
import { barcodeStep } from './steps/barcodes.ts';
import { SavedViews } from './views.ts';
import { matchStep } from './steps/match.ts';
import { Devices } from './devices.ts';
import { log } from './log.ts';
import { ServerMetrics } from './observability.ts';
import { archiveFromEnv, extractionFromEnv, retentionFromEnv, trashFromEnv } from './config.ts';
import { nativeArchiveSource } from './native-archive.ts';
import { createIngestServer } from './server.ts';
import { PRIMARY_CONNECTOR, Storage } from './storage.ts';
import { SuggestionFetcher } from './suggestion-fetcher.ts';
import { DEFAULT_TRASH_DAYS, TrashSweeper } from './trash.ts';

/**
 * Entry point. Configuration is environment only — nothing about where documents
 * live or which token is accepted belongs in a file that might get committed.
 */
const token = process.env['SHEAF_TOKEN'];
if (token === undefined || token.length < 16) {
  // Refuse to start rather than come up with a guessable token: this server holds
  // documents, and a weak default would be the worst possible one.
  log.error('SHEAF_TOKEN must be set to at least 16 characters.', {
    hint: "node -e \"log.info(require('crypto').randomBytes(32).toString('hex'))\"",
  });
  process.exit(1);
}

const dataDir = process.env['SHEAF_DATA_DIR'] ?? join(process.cwd(), '.sheaf-data');
const port = Number(process.env['PORT'] ?? 8787);

// SQLite will not create the directory it is asked to open a file in, so first
// run fails with a bare "unable to open database file" unless we make it first.
mkdirSync(dataDir, { recursive: true });

const driver = nodeSqliteDriver(join(dataDir, 'ingest.db'));
const storage = await Storage.open({ driver, objectsDir: join(dataDir, 'objects') });
const rules = new Rules(driver, storage);
const customFields = new CustomFields(driver, storage);
const edits = new DocumentEdits(storage, driver);
// Email for workflows, when SHEAF_SMTP_HOST is set: STARTTLS on 587 by default,
// TLS from the start with SHEAF_SMTP_SECURITY=tls (465).
const smtpHost = process.env['SHEAF_SMTP_HOST'];
const smtp =
  smtpHost === undefined || smtpHost === ''
    ? null
    : (() => {
        const security = process.env['SHEAF_SMTP_SECURITY'] ?? 'starttls';
        const smtpPort = Number(process.env['SHEAF_SMTP_PORT'] ?? (security === 'tls' ? 465 : 587));
        const from = process.env['SHEAF_SMTP_FROM'] ?? '';
        if ((security !== 'tls' && security !== 'starttls') || !EMAIL_PATTERN.test(from)) {
          log.error(
            'smtp: SHEAF_SMTP_FROM must be an address, and SHEAF_SMTP_SECURITY tls or starttls',
          );
          process.exit(1);
        }
        return {
          from,
          user: process.env['SHEAF_SMTP_USER'] ?? null,
          password: process.env['SHEAF_SMTP_PASSWORD'] ?? null,
          hostname: 'sheaf.local',
          connect: (): Promise<Duplex> =>
            new Promise((resolve, reject) => {
              const socket =
                security === 'tls'
                  ? tlsConnect({ host: smtpHost, port: smtpPort, servername: smtpHost }, () =>
                      resolve(socket),
                    )
                  : netConnect(smtpPort, smtpHost, () => resolve(socket));
              socket.once('error', reject);
            }),
          ...(security === 'starttls'
            ? {
                upgrade: (plain: Duplex): Promise<Duplex> =>
                  new Promise((resolve, reject) => {
                    const secure = tlsConnect({ socket: plain, servername: smtpHost }, () =>
                      resolve(secure),
                    );
                    secure.once('error', reject);
                  }),
              }
            : {}),
        };
      })();
const users = new Users(driver);

// Single sign-on, when SHEAF_OIDC_ISSUER is set.
const oidcIssuer = process.env['SHEAF_OIDC_ISSUER'];
let sso: Sso | null = null;
if (oidcIssuer !== undefined && oidcIssuer !== '') {
  const clientId = process.env['SHEAF_OIDC_CLIENT_ID'] ?? '';
  const clientSecret = process.env['SHEAF_OIDC_CLIENT_SECRET'] ?? '';
  const redirectUri = process.env['SHEAF_OIDC_REDIRECT_URI'] ?? '';
  const webUrl = process.env['SHEAF_WEB_URL'] ?? '';
  const role = process.env['SHEAF_OIDC_DEFAULT_ROLE'] ?? 'viewer';
  if (
    clientId === '' ||
    clientSecret === '' ||
    !/^https?:\/\//.test(redirectUri) ||
    !/^https?:\/\//.test(webUrl) ||
    !['admin', 'editor', 'viewer', 'none'].includes(role)
  ) {
    log.error(
      'sso: SHEAF_OIDC_CLIENT_ID, SHEAF_OIDC_CLIENT_SECRET, SHEAF_OIDC_REDIRECT_URI and SHEAF_WEB_URL are required, and SHEAF_OIDC_DEFAULT_ROLE must be admin, editor, viewer or none',
    );
    process.exit(1);
  }
  sso = new Sso(
    {
      issuer: oidcIssuer,
      clientId,
      clientSecret,
      redirectUri,
      webUrl,
      defaultRole: role === 'none' ? null : (role as 'admin' | 'editor' | 'viewer'),
      usernameClaim: process.env['SHEAF_OIDC_USERNAME_CLAIM'] ?? 'preferred_username',
      name: process.env['SHEAF_OIDC_NAME'] ?? 'single sign-on',
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    },
    users,
  );
  log.info(`sso: signing in through ${oidcIssuer}`);
}

const workflows = new Workflows(driver, storage, customFields, {
  fetch: (url, init) => fetch(url, init),
  warn: (message) => log.error(message),
  ...(smtp === null ? {} : { sendMail: (mail: OutgoingMail) => sendMail(smtp, mail) }),
});
if (smtp !== null) log.info(`smtp: workflows send email through ${smtpHost} as ${smtp.from}`);

// Scheduled workflows look at documents that reached their age, every hour.
let schedulingWorkflows = false;
const runScheduledWorkflows = () => {
  if (schedulingWorkflows) return;
  schedulingWorkflows = true;
  void workflows
    .runScheduled(Date.now())
    .then((acted) => {
      if (acted > 0) log.info(`workflows: scheduled ones acted on ${String(acted)} document(s)`);
    })
    .catch((error: unknown) => log.error('scheduled workflows failed', { error: String(error) }))
    .finally(() => {
      schedulingWorkflows = false;
    });
};
setTimeout(runScheduledWorkflows, 60_000);
setInterval(runScheduledWorkflows, 60 * 60_000);

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
  log.error(retentionSetting.message);
  process.exit(1);
}
const retention = retentionSetting.kind === 'on' ? retentionSetting.config : null;

const trashSetting = trashFromEnv(process.env, DEFAULT_TRASH_DAYS);
if (trashSetting.kind === 'invalid') {
  log.error(trashSetting.message);
  process.exit(1);
}
const trashDays = trashSetting.days;

// What an admin may change from the web app. The environment gives the starting
// values; a value saved from the web app wins over it.
const settings = await Settings.open(driver, {
  ...(process.env['SHEAF_TRASH_DAYS'] === undefined ? {} : { trashDays }),
  ...(process.env['SHEAF_FILENAME_FORMAT'] === undefined
    ? {}
    : { filenameFormat: process.env['SHEAF_FILENAME_FORMAT'] }),
  ...(process.env['SHEAF_BARCODES'] === undefined
    ? {}
    : { barcodesEnabled: process.env['SHEAF_BARCODES'] === 'true' }),
  ...(process.env['SHEAF_BARCODE_SEPARATOR'] === undefined
    ? {}
    : { barcodeSeparator: process.env['SHEAF_BARCODE_SEPARATOR'] }),
  ...(process.env['SHEAF_BARCODE_ASN_PREFIX'] === undefined
    ? {}
    : { barcodeAsnPrefix: process.env['SHEAF_BARCODE_ASN_PREFIX'] }),
  // Checked with the rest of extraction's settings below, so a bad value stops the
  // server there with a message.
  ...(process.env['SHEAF_DATE_ORDER'] === undefined
    ? {}
    : { dateOrder: process.env['SHEAF_DATE_ORDER'] as DateOrderSetting }),
  ...(process.env['SHEAF_CURRENCY'] === undefined
    ? {}
    : { defaultCurrency: process.env['SHEAF_CURRENCY'].toUpperCase() }),
});

const archiveChoice = archiveFromEnv(process.env, paperlessUrl !== undefined);
if (archiveChoice.kind === 'invalid') {
  log.error(archiveChoice.message);
  process.exit(1);
}

const extraction = extractionFromEnv(process.env, paperlessUrl !== undefined, (url, init) =>
  fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(120_000) }),
);
if (extraction.kind === 'invalid') {
  log.error(extraction.message);
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
log.info(
  `archive: /v1/archive browses ${archiveChoice.kind === 'native' ? 'this server' : 'Paperless'}`,
);

// Text kept before re-scans were looked for gets its summary now, oldest first, so
// each document is compared with the ones that came before it.
const nearDuplicates = new NearDuplicates(driver);
void nearDuplicates.fillMissing().then(
  (n) => {
    if (n > 0) log.info(`near-duplicates: summarised the text of ${String(n)} documents`);
  },
  (error: unknown) => log.error(`near-duplicates: ${String(error)}`),
);

const server = createIngestServer({
  storage,
  token,
  // Paired phones (ADR 0008). SHEAF_TOKEN stays the admin's, and still uploads.
  devices: new Devices(driver, { now: () => Date.now() }),
  metrics: new ServerMetrics(driver),
  now: () => Date.now(),
  ...(forwardingTo === undefined ? {} : { forwardingTo }),
  ...(paperlessClient === null ? {} : { reconciliation: () => reconciliationProbe }),
  ...(archiveSource === null ? {} : { archive: archiveSource }),
  ...(retention === null ? {} : { retentionDays: retention.ms / 86_400_000 }),
  trashDays,
  customFields,
  labels: new Labels(driver, storage),
  rules,
  views: new SavedViews(driver),
  bulk: new BulkEditor(storage, customFields, rules),
  shareLinks: new ShareLinks(driver, storage),
  workflows,
  users,
  ...(sso === null ? {} : { sso }),
  audit: new AuditLog(driver),
  edits,
  settings,
  nearDuplicates,
});

// Deleted documents wait in the trash, then go for good (always on: everything it
// deletes, a person deleted first).
const trashSweeper = new TrashSweeper(storage, () => settings.current().trashDays * 86_400_000, {
  now: () => Date.now(),
});
let sweepingTrash = false;
setInterval(() => {
  if (sweepingTrash) return;
  sweepingTrash = true;
  void trashSweeper
    .tick()
    .then(({ purged }) => {
      if (purged > 0) log.info(`trash: deleted ${String(purged)} document(s) for good`);
    })
    .catch((error: unknown) => log.error('emptying the trash failed', { error: String(error) }))
    .finally(() => {
      sweepingTrash = false;
    });
}, 60_000);
log.info(`trash: deleted documents are kept ${String(settings.current().trashDays)} day(s)`);

// A folder a scanner or sync tool drops PDFs into, when SHEAF_CONSUME_DIR is set.
const consumeDir = process.env['SHEAF_CONSUME_DIR'];
if (consumeDir !== undefined && consumeDir !== '') {
  mkdirSync(consumeDir, { recursive: true });
  const consume = new ConsumeFolder(storage, consumeDir, {
    subdirsAsTags: process.env['SHEAF_CONSUME_SUBDIRS_AS_TAGS'] === 'true',
    doubleSided: process.env['SHEAF_CONSUME_DOUBLE_SIDED_DIR'] ?? 'double-sided',
    now: () => Date.now(),
  });
  let consuming = false;
  setInterval(() => {
    if (consuming) return;
    consuming = true;
    void consume
      .tick()
      .then(({ stored, duplicates, failed }) => {
        if (stored + duplicates + failed > 0) {
          log.info(
            `consume: ${String(stored)} stored, ${String(duplicates)} already here, ${String(failed)} moved to failed/`,
          );
        }
      })
      .catch((error: unknown) =>
        log.error('reading the consume folder failed', { error: String(error) }),
      )
      .finally(() => {
        consuming = false;
      });
  }, 5_000);
  log.info(`consume: taking in PDFs from ${consumeDir}`);
}

// PDFs attached to unread mail, when SHEAF_MAIL_HOST is set. TLS only (port 993):
// a mail password is not sent in the clear.
const mailHost = process.env['SHEAF_MAIL_HOST'];
if (mailHost !== undefined && mailHost !== '') {
  const user = process.env['SHEAF_MAIL_USER'] ?? '';
  const password = process.env['SHEAF_MAIL_PASSWORD'] ?? '';
  const after = process.env['SHEAF_MAIL_AFTER'] ?? 'seen';
  const mailPort = Number(process.env['SHEAF_MAIL_PORT'] ?? 993);
  const minutes = Number(process.env['SHEAF_MAIL_INTERVAL_MINUTES'] ?? 5);
  if (
    user === '' ||
    password === '' ||
    (after !== 'seen' && after !== 'delete') ||
    !Number.isInteger(mailPort) ||
    !(minutes >= 1)
  ) {
    log.error(
      'mail: SHEAF_MAIL_USER and SHEAF_MAIL_PASSWORD are required, SHEAF_MAIL_AFTER must be seen or delete, and SHEAF_MAIL_INTERVAL_MINUTES at least 1',
    );
    process.exit(1);
  }
  const mail = new MailFetcher(storage, {
    user,
    password,
    folder: process.env['SHEAF_MAIL_FOLDER'] ?? 'INBOX',
    after,
    tag: process.env['SHEAF_MAIL_TAG'] ?? null,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = tlsConnect({ host: mailHost, port: mailPort, servername: mailHost }, () =>
          resolve(socket),
        );
        socket.once('error', reject);
      }),
    now: () => Date.now(),
  });
  let fetchingMail = false;
  const fetchMail = () => {
    if (fetchingMail) return;
    fetchingMail = true;
    void mail
      .tick()
      .then(({ messages, stored, duplicates, failed }) => {
        if (messages > 0) {
          log.info(
            `mail: ${String(messages)} message(s); ${String(stored)} stored, ${String(duplicates)} already here, ${String(failed)} failed`,
          );
        }
      })
      .catch((error: unknown) => log.error('reading mail failed', { error: String(error) }))
      .finally(() => {
        fetchingMail = false;
      });
  };
  fetchMail();
  setInterval(fetchMail, minutes * 60_000);
  log.info(`mail: taking in PDFs from ${user} on ${mailHost} every ${String(minutes)} minute(s)`);
}

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
      .catch((error: unknown) => log.error('forwarding failed', { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, 5_000);
  log.info(`forwarding to ${forwardingTo ?? 'unknown'}`);

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
      .catch((error: unknown) => log.error('fetching suggestions failed', { error: String(error) }))
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
        .catch((error: unknown) => log.error('retention sweep failed', { error: String(error) }))
        .finally(() => {
          releasing = false;
        });
    }, 60_000);
    log.info(
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
  log.info(
    paperlessUrl === undefined
      ? 'no connectors: documents are stored and searched here, and sent nowhere else'
      : 'forwarding disabled — could not get a token from ' + paperlessUrl,
  );
}
// Copies to a WebDAV server and to a folder, each beside Paperless or on its own.
// Each keeps its own delivery record, so adding one later sends it everything.
function copyEverything(target: Connector, where: string): void {
  const forwarder = new Forwarder(storage, target, {
    now: () => Date.now(),
    jitter: () => Math.random(),
  });
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void forwarder
      .tick()
      .catch((error: unknown) => log.error(`copying to ${where} failed`, { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, 10_000);
  log.info(`copying every document to ${where}`);
}
const webdavUrl = process.env['SHEAF_WEBDAV_URL'];
if (webdavUrl !== undefined && webdavUrl !== '') {
  copyEverything(
    webdavTarget({
      url: webdavUrl,
      username: process.env['SHEAF_WEBDAV_USER'] ?? '',
      password: process.env['SHEAF_WEBDAV_PASSWORD'] ?? '',
      filenameFormat: () => settings.current().filenameFormat,
      record: (sha256) => storage.record(sha256),
    }),
    new URL(webdavUrl).host,
  );
}
const copyDir = process.env['SHEAF_COPY_DIR'];
if (copyDir !== undefined && copyDir !== '') {
  copyEverything(
    folderTarget({
      dir: copyDir,
      filenameFormat: () => settings.current().filenameFormat,
      record: (sha256) => storage.record(sha256),
    }),
    copyDir,
  );
}

/**
 * Work each stored document goes through after it is safe: reading its text,
 * extracting its details. Empty until those steps exist; the loop only starts once
 * there is something for it to do.
 */
const steps: Step[] = [];

// Barcodes on new documents, when the setting is on: separator sheets and serial numbers.
steps.push(barcodeStep(storage, driver, edits, settings, (message) => log.error(message)));

// Filing each new document by the labels' own rules, once its text is in.
const postConsumeScript = process.env['SHEAF_POST_CONSUME_SCRIPT'];
steps.push(
  matchStep(storage, rules, {
    graceMs: 120_000,
    workflows,
    ...(postConsumeScript === undefined || postConsumeScript === ''
      ? {}
      : {
          postConsume: { script: postConsumeScript, warn: (message: string) => log.error(message) },
        }),
  }),
);
if (postConsumeScript !== undefined && postConsumeScript !== '') {
  log.info(`post-consume: running ${postConsumeScript} for each new document`);
}

// Reading each document's details (ADR 0010), unless Paperless's suggestions were chosen.
if (extraction.kind === 'native') {
  steps.push(
    extractStep(storage, {
      extractor: extraction.extractor,
      // Read on every run, so a change on the settings page applies to the next document.
      locale: () => {
        const { dateOrder, defaultCurrency } = settings.current();
        return { dateOrder, defaultCurrency };
      },
      graceMs: 120_000,
    }),
  );
  log.info(
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
      .catch((error: unknown) => log.error('a job crashed', { error: String(error) }))
      .finally(() => {
        runningJobs = false;
      });
  }, 2_000);
  log.info(`jobs: ${steps.map((step) => step.name).join(', ')}`);
}

server.listen(port, () => {
  log.info(`sheaf-ingest listening on http://localhost:${port}`);
  log.info(`documents: ${dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      driver.close();
      process.exit(0);
    });
  });
}
