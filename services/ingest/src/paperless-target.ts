import { captureFilename, interpretTask, type PaperlessClient } from '@sheaf/paperless';
import type { ServerOutcome } from '@sheaf/core';
import { err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import type { ForwardTarget } from './forwarder.ts';

/**
 * Paperless-ngx as a forwarding target.
 *
 * Everything Paperless-specific lives here: its multipart upload, its task queue,
 * and the fact that a duplicate arrives as a *failed* task whose message has to be
 * read. The forwarder above knows none of it.
 *
 * Note where this now runs. All of that awkwardness used to be on a phone, over a
 * flaky connection, with the user waiting. Here it is a server talking to a server,
 * where a retry costs nothing and nobody is watching.
 */
export function paperlessTarget(client: PaperlessClient): ForwardTarget {
  return {
    send(document: DocumentRecord, bytes: Uint8Array): Promise<ApiResult<string>> {
      const filename = captureFilename(document.sha256);
      const fields: Record<string, string> = {};
      if (document.title !== null) fields['title'] = document.title;

      return client.postDocument(
        {
          // Node's Blob satisfies what FormData needs; no file path involved, so the
          // bytes we verified are exactly the bytes that go out.
          part: new Blob([bytes], { type: 'application/pdf' }),
          filename,
        },
        fields,
      );
    },

    /**
     * Paperless can confirm an upload without saying which document it became, so
     * the id is looked up by the filename every upload carries -- the same
     * content-hash trick the phone used to use for crash recovery.
     */
    async locate(sha256: string): Promise<ApiResult<string | null>> {
      const found = await client.findByCaptureId(sha256);
      if (!found.ok) return err(found.reason);
      return ok(found.value === null ? null : String(found.value));
    },

    async poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>> {
      const result = await client.getTask(taskId);
      if (!result.ok) return err(result.reason);
      if (result.value === null) return ok(null);
      return ok(interpretTask(result.value));
    },
  };
}
