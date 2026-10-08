/**
 * Reading configuration out of the environment, kept apart from `main.ts` so it can
 * be tested without starting a server.
 */

export interface RetentionConfig {
  readonly ms: number;
  /** The connector trusted to hold the only remaining copy. */
  readonly connector: string;
}

export type RetentionSetting =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly config: RetentionConfig }
  /** Configured in a way that must stop the server from starting. */
  | { readonly kind: 'invalid'; readonly message: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Free disk space held by documents a connector has confirmed it holds.
 *
 * Off unless `SHEAF_RETENTION_DAYS` is set. Since Sheaf became the system of record
 * (ADR 0007), no connector is assumed to be the archive, so the operator also names
 * the one they trust with `SHEAF_RETENTION_CONNECTOR`. A setting that would free
 * bytes without saying who holds them refuses to start the server: silently
 * ignoring it would leave someone believing their disk is managed, and guessing
 * would delete their only copy.
 */
export function retentionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  connectors: readonly string[],
): RetentionSetting {
  const rawDays = env['SHEAF_RETENTION_DAYS'];
  if (rawDays === undefined || rawDays === '') return { kind: 'off' };

  const days = Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) {
    return {
      kind: 'invalid',
      message: `SHEAF_RETENTION_DAYS must be a positive number of days, got "${rawDays}".`,
    };
  }

  const connector = env['SHEAF_RETENTION_CONNECTOR'];
  if (connector === undefined || connector === '') {
    return {
      kind: 'invalid',
      message:
        'SHEAF_RETENTION_DAYS is set, so set SHEAF_RETENTION_CONNECTOR to the connector ' +
        'trusted to keep the only copy (for example "paperless"), or unset the days.',
    };
  }
  if (!connectors.includes(connector)) {
    return {
      kind: 'invalid',
      message:
        `SHEAF_RETENTION_CONNECTOR is "${connector}", which is not configured ` +
        `(configured: ${connectors.length === 0 ? 'none' : connectors.join(', ')}).`,
    };
  }
  return { kind: 'on', config: { ms: days * DAY_MS, connector } };
}

export type ArchiveChoice =
  | { readonly kind: 'native' | 'paperless' }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Which archive the phone's library browses: the server's own catalog (`native`, the
 * default since ADR 0007), or Paperless's, live. Choosing Paperless without
 * configuring it fails at start rather than leaving the library quietly empty.
 */
export function archiveFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  paperlessConfigured: boolean,
): ArchiveChoice {
  const raw = env['SHEAF_ARCHIVE_SOURCE'];
  if (raw === undefined || raw === '' || raw === 'native') return { kind: 'native' };
  if (raw === 'paperless') {
    return paperlessConfigured
      ? { kind: 'paperless' }
      : {
          kind: 'invalid',
          message: 'SHEAF_ARCHIVE_SOURCE is "paperless", so PAPERLESS_URL must be set too.',
        };
  }
  return {
    kind: 'invalid',
    message: `SHEAF_ARCHIVE_SOURCE must be "native" or "paperless", got "${raw}".`,
  };
}
