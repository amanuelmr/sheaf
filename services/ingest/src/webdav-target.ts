import type { ServerOutcome } from '@sheaf/core';
import { classifyResponse, classifyThrown, err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import { renderFilename } from './filename.ts';
import type { Connector } from './forwarder.ts';

export interface WebDavOptions {
  /** The folder documents go in, such as https://cloud.example.com/remote.php/dav/files/ann/Scans/ */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** How files are named, read on each send; see `TEMPLATE_PLACEHOLDERS`. */
  readonly filenameFormat: () => string;
  /** The document as it is now, for finding a file sent before a restart. */
  readonly record: (sha256: string) => Promise<DocumentRecord | null>;
  readonly fetch?: typeof fetch;
}

/** The name in the deliveries table. Never change it: a new name sends everything again. */
export const WEBDAV_CONNECTOR = 'webdav';

/**
 * A WebDAV server as a forwarding target: Nextcloud, ownCloud, a NAS, or anything
 * else that speaks it. Each document becomes a PDF named by the export file name
 * format, with the start of its hash added so two documents never take the same
 * name. A PUT of the same bytes to the same name is harmless, which makes sending
 * again after a lost reply safe.
 */
export function webdavTarget(options: WebDavOptions): Connector {
  const base = options.url.endsWith('/') ? options.url : `${options.url}/`;
  const doFetch = options.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;

  const pathOf = (record: DocumentRecord): string =>
    `${renderFilename(options.filenameFormat(), record)} ${record.sha256.slice(0, 8)}.pdf`;
  const urlOf = (path: string): string =>
    new URL(path.split('/').map(encodeURIComponent).join('/'), base).toString();

  async function request(
    method: string,
    path: string,
    body?: Uint8Array,
  ): Promise<ApiResult<number>> {
    try {
      const response = await doFetch(urlOf(path), {
        method,
        headers: {
          authorization: auth,
          ...(body === undefined ? {} : { 'content-type': 'application/pdf' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(60_000),
      });
      await response.body?.cancel();
      return ok(response.status);
    } catch (error) {
      return err(classifyThrown(error));
    }
  }

  /** Is the file there? 200 yes, 404 no, anything else could not tell. */
  async function exists(path: string): Promise<ApiResult<boolean>> {
    const head = await request('HEAD', path);
    if (!head.ok) return head;
    if (head.value === 404) return ok(false);
    if (head.value >= 200 && head.value < 300) return ok(true);
    return err(classifyResponse(head.value));
  }

  return {
    name: WEBDAV_CONNECTOR,

    async send(document: DocumentRecord, bytes: Uint8Array): Promise<ApiResult<string>> {
      const path = pathOf(document);
      // WebDAV makes no folders on the way to a file; each is made in turn, and one
      // already there answers 405, which is just as good.
      const folders = path.split('/').slice(0, -1);
      for (let i = 1; i <= folders.length; i++) {
        const made = await request('MKCOL', `${folders.slice(0, i).join('/')}/`);
        if (!made.ok) return made;
        if (made.value !== 201 && made.value !== 405 && made.value !== 301) {
          return err(classifyResponse(made.value));
        }
      }
      const put = await request('PUT', path, bytes);
      if (!put.ok) return put;
      if (put.value < 200 || put.value >= 300) return err(classifyResponse(put.value));
      return ok(path);
    },

    async poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>> {
      const there = await exists(taskId);
      if (!there.ok) return there;
      // Not there after a PUT that said yes: someone removed it. Send it again.
      return ok(there.value ? { kind: 'stored', remoteId: taskId } : null);
    },

    async locate(sha256: string): Promise<ApiResult<string | null>> {
      const record = await options.record(sha256);
      if (record === null) return ok(null);
      const path = pathOf(record);
      const there = await exists(path);
      if (!there.ok) return there;
      return ok(there.value ? path : null);
    },
  };
}
