/**
 * Minimal HTTP surface, declared here rather than pulled from lib.dom.
 *
 * This package runs in three places: Node (tests), Hermes (React Native), and
 * whatever CI uses. Depending on DOM types would be a lie in two of them, and
 * injecting the transport is what makes the client testable without a network.
 */

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: HttpHeaders;
  text(): Promise<string>;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: HttpRequest) => Promise<HttpResponse>;

/** The bits of FormData we use. RN and Node both satisfy this. */
export interface FormDataLike {
  append(name: string, value: unknown, filename?: string): void;
}

export type FormDataFactory = () => FormDataLike;

/**
 * A file to upload, kept opaque on purpose: React Native appends
 * `{ uri, name, type }`, Node appends a Blob. The client does not need to know.
 */
export interface UploadFile {
  readonly part: unknown;
  readonly filename: string;
}
