import type { ServerOutcome } from '@sheaf/core';
import { classifyResponse, classifyThrown, err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import type { Connector } from './forwarder.ts';

export interface PapraOptions {
  /** The Papra server, such as https://papra.example.com */
  readonly url: string;
  /** An API key made under the organisation's settings, with documents:create and documents:read. */
  readonly apiKey: string;
  readonly organizationId: string;
  readonly fetch?: typeof fetch;
}

/** The name in the deliveries table. Never change it: a new name sends everything again. */
export const PAPRA_CONNECTOR = 'papra';

/** A task id for a document Papra already had: its own id is not in the refusal. */
const ALREADY_THERE = 'sha256:';

/** How far back `locate` looks through the organisation's documents, 100 at a time. */
const LOCATE_PAGES = 20;

interface PapraDocument {
  readonly id?: unknown;
  readonly originalSha256Hash?: unknown;
}

/**
 * Papra as a forwarding target. Each document is uploaded as it was stored, not
 * the copy with text inside: Papra reads the text itself, and it recognises a
 * document it already holds by the SHA-256 of the file, which is then the same
 * hash Sheaf files it under. A second upload of the same file is refused with
 * 409 rather than stored twice, so sending again after a lost reply is safe.
 */
export function papraTarget(options: PapraOptions): Connector {
  const base = `${options.url.replace(/\/+$/, '')}/api/organizations/${encodeURIComponent(options.organizationId)}/documents`;
  const doFetch = options.fetch ?? fetch;
  const headers = { authorization: `Bearer ${options.apiKey}` };

  async function call(
    url: string,
    init: RequestInit = {},
  ): Promise<ApiResult<{ status: number; body: unknown }>> {
    try {
      const response = await doFetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      return ok({ status: response.status, body });
    } catch (error) {
      return err(classifyThrown(error));
    }
  }

  const idOf = (body: unknown): string | null => {
    const document = (body as { document?: PapraDocument } | null)?.document;
    return typeof document?.id === 'string' ? document.id : null;
  };

  async function locate(sha256: string): Promise<ApiResult<string | null>> {
    for (let page = 0; page < LOCATE_PAGES; page++) {
      const listed = await call(
        `${base}?pageIndex=${String(page)}&pageSize=100&sortField=createdAt&sortOrder=desc`,
      );
      if (!listed.ok) return listed;
      if (listed.value.status !== 200) return err(classifyResponse(listed.value.status));
      const documents = (listed.value.body as { documents?: PapraDocument[] } | null)?.documents;
      if (!Array.isArray(documents)) return ok(null);
      const found = documents.find((d) => d.originalSha256Hash === sha256);
      if (found !== undefined && typeof found.id === 'string') return ok(found.id);
      if (documents.length < 100) return ok(null);
    }
    return ok(null);
  }

  return {
    name: PAPRA_CONNECTOR,

    async send(document: DocumentRecord, bytes: Uint8Array): Promise<ApiResult<string>> {
      const form = new FormData();
      const name = `${(document.title ?? document.sha256.slice(0, 12)).replace(/[/\\]/g, '-')}.pdf`;
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
      const sent = await call(base, { method: 'POST', body: form });
      if (!sent.ok) return sent;
      const { status, body } = sent.value;
      if (status === 409) return ok(`${ALREADY_THERE}${document.sha256}`);
      if (status < 200 || status >= 300) return err(classifyResponse(status));
      return ok(idOf(body) ?? `${ALREADY_THERE}${document.sha256}`);
    },

    async poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>> {
      if (taskId.startsWith(ALREADY_THERE)) {
        const found = await locate(taskId.slice(ALREADY_THERE.length));
        if (!found.ok) return found;
        return ok({ kind: 'duplicate', remoteId: found.value });
      }
      const got = await call(`${base}/${encodeURIComponent(taskId)}`);
      if (!got.ok) return got;
      // Gone after Papra said it had it: someone removed it. Send it again.
      if (got.value.status === 404) return ok(null);
      if (got.value.status !== 200) return err(classifyResponse(got.value.status));
      return ok({ kind: 'stored', remoteId: taskId });
    },

    locate,
  };
}
