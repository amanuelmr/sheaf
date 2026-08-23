/** Shape of a row from GET /api/tasks/. Fields vary by Paperless version. */
export interface PaperlessTask {
  readonly task_id: string;
  readonly status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | (string & {});
  readonly result?: string | null;
  readonly related_document?: number | string | null;
}

export interface ServerInfo {
  readonly version: string | null;
  readonly host: string;
}
