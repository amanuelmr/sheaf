import {
  authorization,
  filterToParams,
  paths,
  type CustomField,
  type CustomFieldBody,
  type CustomFieldPatch,
  type CustomFieldValue,
  type CustomFieldValuesBody,
  type CustomFieldsResponse,
  type DocumentCustomFieldsResponse,
  type DevicesResponse,
  type DocumentPatch,
  type DocumentRecord,
  type FieldsResponse,
  type HealthResponse,
  type HistoryResponse,
  type InboxResponse,
  type Label,
  type LabelBody,
  type LabelKind,
  type LabelPatch,
  type LabelsResponse,
  type DocumentPermissions,
  type UserDirectoryResponse,
  type SettingsResponse,
  type NewDocumentsResponse,
  type PageCountResponse,
  type PageSpec,
  type VersionsResponse,
  type AuditResponse,
  type Me,
  type SessionResponse,
  type User,
  type UserBody,
  type UserPatch,
  type UsersResponse,
  type Workflow,
  type WorkflowBody,
  type WorkflowsResponse,
  type ShareLink,
  type ShareLinksResponse,
  type NextAsnResponse,
  type CustomFieldSuggestionsResponse,
  type AsnSeries,
  type AsnSeriesBody,
  type AsnSeriesResponse,
  type BulkAction,
  type BulkEditResponse,
  type DocumentFilter,
  type SavedView,
  type SavedViewBody,
  type SavedViewPatch,
  type SavedViewsResponse,
  type ApplyRulesResponse,
  type AccuracyResponse,
  type Note,
  type NoteBody,
  type NotesResponse,
  type PairingCodeResponse,
  type SearchResponse,
  type SimilarResponse,
  type StampBody,
  type TrashActionBody,
  type TrashActionResponse,
  type TrashResponse,
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
    /** Documents the filter lets through; with words in it, a search. */
    find: (filter: DocumentFilter, limit = 50, offset = 0) => {
      const params = filterToParams(filter);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      return call<SearchResponse>('GET', `${paths.search()}?${params.toString()}`);
    },
    bulkEdit: (documents: readonly string[], action: BulkAction) =>
      call<BulkEditResponse>('POST', paths.bulkEdit(), { documents, action }),
    shareLinks: (sha256: string) =>
      call<ShareLinksResponse>('GET', paths.documentShareLinks(sha256)),
    createShareLink: (sha256: string, expiresInDays: number | null) =>
      call<ShareLink>('POST', paths.documentShareLinks(sha256), { expiresInDays }),
    revokeShareLink: (id: number) => call<undefined>('DELETE', paths.shareLink(id)),
    /** The address to hand someone: on the server, since that is what opens it. */
    shareUrl: (slug: string) => url(paths.shared(slug)),
    workflows: () => call<WorkflowsResponse>('GET', paths.workflows()),
    createWorkflow: (body: WorkflowBody) => call<Workflow>('POST', paths.workflows(), body),
    replaceWorkflow: (id: number, body: WorkflowBody) =>
      call<Workflow>('PUT', paths.workflow(id), body),
    deleteWorkflow: (id: number) => call<undefined>('DELETE', paths.workflow(id)),
    audit: (before?: number) =>
      call<AuditResponse>(
        'GET',
        `${paths.audit()}?limit=50${before === undefined ? '' : `&before=${String(before)}`}`,
      ),
    settings: () => call<SettingsResponse>('GET', paths.settings()),
    updateSettings: (patch: object) => call<SettingsResponse>('PATCH', paths.settings(), patch),
    me: () => call<Me>('GET', paths.me()),
    userDirectory: () => call<UserDirectoryResponse>('GET', paths.userDirectory()),
    permissions: (sha256: string) =>
      call<DocumentPermissions>('GET', paths.documentPermissions(sha256)),
    setPermissions: (sha256: string, permissions: DocumentPermissions) =>
      call<DocumentPermissions>('PUT', paths.documentPermissions(sha256), permissions),
    signOut: () => call<undefined>('DELETE', paths.currentSession()),
    users: () => call<UsersResponse>('GET', paths.users()),
    createUser: (body: UserBody) => call<User>('POST', paths.users(), body),
    updateUser: (id: number, patch: UserPatch) => call<User>('PATCH', paths.user(id), patch),
    deleteUser: (id: number) => call<undefined>('DELETE', paths.user(id)),
    pageCount: (sha256: string) => call<PageCountResponse>('GET', paths.documentPages(sha256)),
    editPages: (sha256: string, pages: readonly PageSpec[]) =>
      call<DocumentRecord>('POST', paths.documentPages(sha256), { pages }),
    stamp: (sha256: string, body: StampBody) =>
      call<DocumentRecord>('POST', paths.documentStamp(sha256), body),
    split: (sha256: string, parts: readonly (readonly number[])[], keepOriginal: boolean) =>
      call<NewDocumentsResponse>('POST', paths.documentSplit(sha256), { parts, keepOriginal }),
    merge: (documents: readonly string[], keepOriginals: boolean) =>
      call<DocumentRecord>('POST', paths.mergeDocuments(), { documents, keepOriginals }),
    accuracy: () => call<AccuracyResponse>('GET', paths.accuracy()),
    similar: (sha256: string) => call<SimilarResponse>('GET', paths.documentSimilar(sha256)),
    versions: (sha256: string) => call<VersionsResponse>('GET', paths.documentVersions(sha256)),
    restoreVersion: (sha256: string, version: string) =>
      call<DocumentRecord>('POST', paths.restoreVersion(sha256, version)),
    /** An earlier file as an object URL; revoke it when done. */
    versionPdf: async (sha256: string, version: string): Promise<Result<string>> => {
      try {
        const response = await fetch(url(paths.documentVersion(sha256, version)), {
          headers: headers(),
        });
        if (!response.ok) return { ok: false, message: await explain(response) };
        return { ok: true, value: URL.createObjectURL(await response.blob()) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    nextAsn: (series?: string) =>
      call<NextAsnResponse>(
        'GET',
        series === undefined
          ? paths.nextAsn()
          : `${paths.nextAsn()}?series=${encodeURIComponent(series)}`,
      ),
    asnSeries: () => call<AsnSeriesResponse>('GET', paths.asnSeries()),
    createAsnSeries: (body: AsnSeriesBody) => call<AsnSeries>('POST', paths.asnSeries(), body),
    deleteAsnSeries: (prefix: string) => call<undefined>('DELETE', paths.asnSeriesOne(prefix)),
    views: () => call<SavedViewsResponse>('GET', paths.views()),
    createView: (body: SavedViewBody) => call<SavedView>('POST', paths.views(), body),
    updateView: (id: number, patch: SavedViewPatch) =>
      call<SavedView>('PATCH', paths.view(id), patch),
    deleteView: (id: number) => call<undefined>('DELETE', paths.view(id)),
    recent: () => call<{ documents: readonly DocumentRecord[] }>('GET', paths.documents()),
    inbox: () => call<InboxResponse>('GET', paths.inbox()),
    record: (sha256: string) => call<DocumentRecord>('GET', paths.documentRecord(sha256)),
    fields: (sha256: string) => call<FieldsResponse>('GET', paths.documentFields(sha256)),
    history: (sha256: string) => call<HistoryResponse>('GET', paths.documentHistory(sha256)),
    patch: (sha256: string, patch: DocumentPatch) =>
      call<DocumentRecord>('PATCH', paths.document(sha256), patch),
    notes: (sha256: string) => call<NotesResponse>('GET', paths.documentNotes(sha256)),
    addNote: (sha256: string, text: string) =>
      call<Note>('POST', paths.documentNotes(sha256), { text } satisfies NoteBody),
    deleteNote: (sha256: string, id: number) =>
      call<undefined>('DELETE', paths.documentNote(sha256, id)),
    /** Moves it to the trash; see `restore` to take it back. */
    trashDocument: (sha256: string) => call<undefined>('DELETE', paths.document(sha256)),
    trash: () => call<TrashResponse>('GET', paths.trash()),
    restore: (documents: readonly string[]) =>
      call<TrashActionResponse>('POST', paths.trashRestore(), {
        documents,
      } satisfies TrashActionBody),
    /** Deletes for good: the named documents, or everything in the trash. */
    emptyTrash: (documents?: readonly string[]) =>
      call<TrashActionResponse>(
        'POST',
        paths.trashEmpty(),
        (documents === undefined ? {} : { documents }) satisfies TrashActionBody,
      ),
    customFields: () => call<CustomFieldsResponse>('GET', paths.customFields()),
    createCustomField: (body: CustomFieldBody) =>
      call<CustomField>('POST', paths.customFields(), body),
    updateCustomField: (id: number, patch: CustomFieldPatch) =>
      call<CustomField>('PATCH', paths.customField(id), patch),
    deleteCustomField: (id: number) => call<undefined>('DELETE', paths.customField(id)),
    fieldSuggestions: (sha256: string) =>
      call<CustomFieldSuggestionsResponse>('GET', paths.documentFieldSuggestions(sha256)),
    documentCustomFields: (sha256: string) =>
      call<DocumentCustomFieldsResponse>('GET', paths.documentCustomFields(sha256)),
    setDocumentCustomFields: (sha256: string, values: readonly CustomFieldValue[]) =>
      call<DocumentCustomFieldsResponse>('PUT', paths.documentCustomFields(sha256), {
        values,
      } satisfies CustomFieldValuesBody),
    labels: (kind: LabelKind) => call<LabelsResponse>('GET', paths.labels(kind)),
    createLabel: (kind: LabelKind, body: LabelBody) =>
      call<Label>('POST', paths.labels(kind), body),
    updateLabel: (kind: LabelKind, id: number, patch: LabelPatch) =>
      call<Label>('PATCH', paths.label(kind, id), patch),
    mergeLabel: (kind: LabelKind, id: number, into: number) =>
      call<Label>('POST', paths.labelMerge(kind, id), { into }),
    deleteLabel: (kind: LabelKind, id: number) => call<undefined>('DELETE', paths.label(kind, id)),
    applyRules: () => call<ApplyRulesResponse>('POST', paths.labelsApply(), {}),
    /** Downloads the PDF with its recognised text inside, so other apps can search it. */
    downloadSearchable: async (sha256: string, name: string): Promise<Result<undefined>> => {
      try {
        const response = await fetch(url(paths.documentSearchable(sha256)), {
          headers: headers(),
        });
        if (!response.ok) return { ok: false, message: await explain(response) };
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await response.blob());
        link.download = `${name.replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    /** Downloads every document the filter lets through as a CSV file. */
    exportCsv: async (filter: DocumentFilter): Promise<Result<undefined>> => {
      try {
        const response = await fetch(
          url(`${paths.searchExport()}?${filterToParams(filter).toString()}`),
          { headers: headers() },
        );
        if (!response.ok) return { ok: false, message: await explain(response) };
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await response.blob());
        link.download = `documents-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    /** Stores a PDF under its hash: `stored`, or `known` when the server had it already. */
    upload: async (
      sha256: string,
      bytes: Uint8Array,
      pageCount: number | null,
    ): Promise<Result<'stored' | 'known'>> => {
      try {
        const response = await fetch(url(paths.document(sha256)), {
          method: 'PUT',
          headers: headers({
            'content-type': 'application/pdf',
            ...(pageCount === null ? {} : { 'x-sheaf-page-count': String(pageCount) }),
          }),
          body: bytes as BodyInit,
        });
        if (!response.ok) return { ok: false, message: await explain(response) };
        return { ok: true, value: response.status === 201 ? 'stored' : 'known' };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    /** An EPUB, which the server keeps as a PDF made from it. Answers that document. */
    uploadBook: async (
      bytes: Uint8Array,
    ): Promise<Result<{ state: 'stored' | 'known'; sha256: string }>> => {
      try {
        const response = await fetch(url(paths.books()), {
          method: 'POST',
          headers: headers({ 'content-type': 'application/epub+zip' }),
          body: bytes as BodyInit,
        });
        if (!response.ok) return { ok: false, message: await explain(response) };
        const record = (await response.json()) as DocumentRecord;
        return {
          ok: true,
          value: { state: response.status === 201 ? 'stored' : 'known', sha256: record.sha256 },
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
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

/** Trade a username and password for a session token. Needs no token itself. */
export async function signIn(
  baseUrl: string,
  username: string,
  password: string,
): Promise<Result<SessionResponse>> {
  try {
    const response = await fetch(new URL(paths.sessions(), baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) return { ok: false, message: await explain(response) };
    return { ok: true, value: (await response.json()) as SessionResponse };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function explain(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string };
    return body.detail ?? body.error ?? `${String(response.status)} ${response.statusText}`;
  } catch {
    return `${String(response.status)} ${response.statusText}`;
  }
}
