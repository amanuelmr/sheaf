import type { FetchLike, FormDataFactory } from '@sheaf/http';

/**
 * Paperless-ngx negotiates its API version in the `Accept` header, and 3.x refuses
 * anything below 9. Asked for explicitly, so the shapes Sheaf reads are the ones a
 * test suite ran against rather than whatever the server defaults to that day.
 */
export const DEFAULT_API_VERSION = 9;

export interface PaperlessConfig {
  /** Base URL of the Paperless-ngx server, with or without a trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly formData?: FormDataFactory;
  readonly timeoutMs?: number;
  /** API version to ask for. Defaults to {@link DEFAULT_API_VERSION}. */
  readonly apiVersion?: number;
}
