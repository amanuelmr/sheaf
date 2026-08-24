import type { FetchLike, FormDataFactory } from '@sheaf/http';

export interface PaperlessConfig {
  /** Base URL of the Paperless-ngx server, with or without a trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly formData?: FormDataFactory;
  readonly timeoutMs?: number;
}
