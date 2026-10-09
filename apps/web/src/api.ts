import {
  authorization,
  paths,
  type DevicesResponse,
  type DocumentPatch,
  type DocumentRecord,
  type FieldsResponse,
  type HealthResponse,
  type HistoryResponse,
  type InboxResponse,
  type PairingCodeResponse,
  type SearchResponse,
} from '@sheaf/protocol';
import type { Connection } from './connection';

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * Everything the web app asks the server, one function each. No retry and no
 * failure taxonomy: nothing here decides what to do about a failure, it only shows
 * it, so the sync engine's machinery would be weight with no use.
 */
export function api(connection: Connection) {
  const url = (path: string): string => new URL(path, connection.baseUrl).toString();
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: authorization(connection.token),
    ...extra,
  });

  async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const response = await fetch(url(path), {
        method,
        headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) return { ok: false, message: await explain(response) };
      if (response.status === 204) return { ok: true, value: undefined as T };
      return { ok: true, value: (await response.json()) as T };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    health: () => call<HealthResponse>('GET', paths.health()),
    search: (q: string) =>
      call<SearchResponse>(
        'GET',
        `${paths.search()}?${new URLSearchParams({ q, limit: '50' }).toString()}`,
      ),
    recent: () => call<{ documents: readonly DocumentRecord[] }>('GET', paths.documents()),
    inbox: () => call<InboxResponse>('GET', paths.inbox()),
    record: (sha256: string) => call<DocumentRecord>('GET', paths.documentRecord(sha256)),
    fields: (sha256: string) => call<FieldsResponse>('GET', paths.documentFields(sha256)),
    history: (sha256: string) => call<HistoryResponse>('GET', paths.documentHistory(sha256)),
    patch: (sha256: string, patch: DocumentPatch) =>
      call<DocumentRecord>('PATCH', paths.document(sha256), patch),
    /** The PDF as an object URL for an iframe; revoke it when done. */
    pdf: async (sha256: string): Promise<Result<string>> => {
      try {
        const response = await fetch(url(paths.document(sha256)), { headers: headers() });
        if (!response.ok) return { ok: false, message: await explain(response) };
        return { ok: true, value: URL.createObjectURL(await response.blob()) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    createPairingCode: () => call<PairingCodeResponse>('POST', paths.pairingCodes()),
    devices: () => call<DevicesResponse>('GET', paths.devices()),
    revoke: (id: string) => call<undefined>('DELETE', paths.device(id)),
  };
}

export type Api = ReturnType<typeof api>;

async function explain(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string };
    return body.detail ?? body.error ?? `${String(response.status)} ${response.statusText}`;
  } catch {
    return `${String(response.status)} ${response.statusText}`;
  }
}
