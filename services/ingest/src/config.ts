import {
  claudeExtractor,
  heuristicExtractor,
  ollamaExtractor,
  type DateOrder,
  type Extractor,
} from '@sheaf/extract';
import type { FetchLike } from '@sheaf/http';

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

export type ExtractionChoice =
  | {
      readonly kind: 'native';
      readonly extractor: Extractor;
      readonly dateOrder: DateOrder;
      readonly defaultCurrency: string;
      /** True when document text leaves this server to be read. */
      readonly sendsTextAway: boolean;
    }
  /** Paperless's own classifier, fetched once it has a document (the old behaviour). */
  | { readonly kind: 'paperless' }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Who reads each document's details (ADR 0010). The default sends nothing anywhere;
 * sending text to a model provider is the operator's explicit choice.
 */
export function extractionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  paperlessConfigured: boolean,
  fetch: FetchLike,
): ExtractionChoice {
  const order = env['SHEAF_DATE_ORDER'] ?? 'DMY';
  if (order !== 'DMY' && order !== 'MDY' && order !== 'YMD') {
    return {
      kind: 'invalid',
      message: `SHEAF_DATE_ORDER must be DMY, MDY or YMD, got "${order}".`,
    };
  }
  const currency = (env['SHEAF_CURRENCY'] ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return {
      kind: 'invalid',
      message: `SHEAF_CURRENCY must be an ISO 4217 code, got "${currency}".`,
    };
  }
  const native = (extractor: Extractor, sendsTextAway: boolean): ExtractionChoice => ({
    kind: 'native',
    extractor,
    dateOrder: order,
    defaultCurrency: currency,
    sendsTextAway,
  });

  const choice = env['SHEAF_EXTRACTOR'] ?? 'heuristic';
  switch (choice) {
    case '':
    case 'heuristic':
      return native(heuristicExtractor(), false);
    case 'claude': {
      const apiKey = env['ANTHROPIC_API_KEY'];
      if (apiKey === undefined || apiKey === '') {
        return {
          kind: 'invalid',
          message: 'SHEAF_EXTRACTOR is "claude", so set ANTHROPIC_API_KEY.',
        };
      }
      const model = env['SHEAF_CLAUDE_MODEL'];
      return native(
        claudeExtractor({
          apiKey,
          fetch,
          ...(model === undefined || model === '' ? {} : { model }),
        }),
        true,
      );
    }
    case 'ollama': {
      const url = env['SHEAF_OLLAMA_URL'];
      const model = env['SHEAF_OLLAMA_MODEL'];
      if (url === undefined || url === '' || model === undefined || model === '') {
        return {
          kind: 'invalid',
          message: 'SHEAF_EXTRACTOR is "ollama", so set SHEAF_OLLAMA_URL and SHEAF_OLLAMA_MODEL.',
        };
      }
      return native(ollamaExtractor({ url, model, fetch }), false);
    }
    case 'paperless':
      return paperlessConfigured
        ? { kind: 'paperless' }
        : {
            kind: 'invalid',
            message: 'SHEAF_EXTRACTOR is "paperless", so PAPERLESS_URL must be set too.',
          };
    default:
      return {
        kind: 'invalid',
        message: `SHEAF_EXTRACTOR must be heuristic, claude, ollama or paperless, got "${choice}".`,
      };
  }
}
