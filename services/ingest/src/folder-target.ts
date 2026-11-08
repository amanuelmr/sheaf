import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ServerOutcome } from '@sheaf/core';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import { renderFilename } from './filename.ts';
import type { Connector } from './forwarder.ts';

export interface FolderTargetOptions {
  /** Where copies go: a NAS share, a synced folder, a backup disk. */
  readonly dir: string;
  readonly filenameFormat: () => string;
  readonly record: (sha256: string) => Promise<DocumentRecord | null>;
  /** The bytes to send for a document; the stored ones when absent. */
  readonly prepare?: (sha256: string, stored: Uint8Array) => Promise<Uint8Array>;
}

/** The name in the deliveries table. Never change it: a new name sends everything again. */
export const FOLDER_CONNECTOR = 'folder';

/**
 * A folder as a forwarding target: each document copied in as a PDF, named by the
 * export file name format plus the start of its hash. Written to a temporary name
 * and renamed, so a sync tool watching the folder never picks up half a file.
 */
export function folderTarget(options: FolderTargetOptions): Connector {
  const root = resolve(options.dir);
  const pathOf = (record: DocumentRecord): string =>
    `${renderFilename(options.filenameFormat(), record)} ${record.sha256.slice(0, 8)}.pdf`;
  const inside = (path: string): string | null => {
    const full = resolve(join(root, path));
    return full.startsWith(root + sep) ? full : null;
  };

  return {
    name: FOLDER_CONNECTOR,

    async send(document: DocumentRecord, stored: Uint8Array): Promise<ApiResult<string>> {
      const bytes =
        options.prepare === undefined ? stored : await options.prepare(document.sha256, stored);
      const path = pathOf(document);
      const full = inside(path);
      if (full === null) return err({ kind: 'not_found' });
      try {
        mkdirSync(dirname(full), { recursive: true });
        const temporary = `${full}.part`;
        writeFileSync(temporary, bytes);
        renameSync(temporary, full);
        return ok(path);
      } catch {
        // A full disk or an unmounted share: worth trying again later.
        return err({ kind: 'unreachable' });
      }
    },

    poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>> {
      const full = inside(taskId);
      return Promise.resolve(
        ok(full !== null && existsSync(full) ? { kind: 'stored', remoteId: taskId } : null),
      );
    },

    async locate(sha256: string): Promise<ApiResult<string | null>> {
      const record = await options.record(sha256);
      if (record === null) return ok(null);
      const path = pathOf(record);
      const full = inside(path);
      return ok(full !== null && existsSync(full) ? path : null);
    },
  };
}
