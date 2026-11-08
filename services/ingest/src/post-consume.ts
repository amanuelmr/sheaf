import { execFile } from 'node:child_process';
import type { DocumentRecord } from '@sheaf/protocol';

export interface ScriptResult {
  readonly ok: boolean;
  /** What went wrong, for the log; never the script's whole output. */
  readonly detail: string;
}

const TIMEOUT_MS = 5 * 60_000;

/** The environment a post-consume script sees: the document, and where its file is. */
export function scriptEnvironment(record: DocumentRecord, file: string): Record<string, string> {
  return {
    DOCUMENT_ID: record.sha256,
    DOCUMENT_FILE: file,
    DOCUMENT_TITLE: record.title ?? '',
    DOCUMENT_CORRESPONDENT: record.correspondent ?? '',
    DOCUMENT_TYPE: record.documentType ?? '',
    DOCUMENT_TAGS: record.tags.join(','),
    DOCUMENT_CREATED: record.created ?? '',
    DOCUMENT_ASN: record.asn === null ? '' : String(record.asn),
    DOCUMENT_RECEIVED: new Date(record.receivedAt).toISOString(),
  };
}

/**
 * Runs the operator's script for one new document. Started directly, not through
 * a shell, so nothing in a title or tag can be read as a command; the details
 * travel only in the environment. A script gets five minutes.
 */
export function runPostConsume(
  script: string,
  record: DocumentRecord,
  file: string,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    execFile(
      script,
      [record.sha256],
      {
        env: { PATH: process.env['PATH'] ?? '', ...scriptEnvironment(record, file) },
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, detail: '' });
          return;
        }
        const why = error.killed
          ? 'took longer than five minutes'
          : `exited with ${String(error.code ?? error.message)}`;
        resolve({
          ok: false,
          detail: `${why}${stderr === '' ? '' : `: ${String(stderr).trim().slice(0, 500)}`}`,
        });
      },
    );
  });
}
