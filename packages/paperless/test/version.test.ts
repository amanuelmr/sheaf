/**
 * Paperless-ngx negotiates its API version through the `Accept` header. Without a
 * version the server picks its default, so the shapes Sheaf reads can change under a
 * build that was never re-tested — the silent version of "it worked yesterday".
 *
 * These tests pin that the version is asked for explicitly, that it is the one we
 * chose, and that a caller can move it without editing the client.
 */
import { describe as suite, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '@sheaf/http';
import { PaperlessClient } from '../src/client';
import type { PaperlessConfig } from '../src/config';

const TOKEN = 'a-token-of-at-least-twenty-characters';

interface Seen {
  readonly path: string;
  readonly headers: Record<string, string>;
}

/** A transport that records each request and answers 200 with a JSON body. */
function transport(seen: Seen[], overrides: Partial<PaperlessConfig> = {}): PaperlessConfig {
  return {
    baseUrl: 'http://paperless:8000',
    token: TOKEN,
    fetch: (url: string, init: HttpRequest = {}): Promise<HttpResponse> => {
      seen.push({
        path: url,
        headers: Object.fromEntries(
          Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
      });
      const response = {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json', 'x-version': '3.2.1' }),
        json: () => Promise.resolve({ results: [], count: 0 }),
        text: () => Promise.resolve('{"results":[],"count":0}'),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      };
      return Promise.resolve(response as unknown as HttpResponse);
    },
    ...overrides,
  };
}

suite('API version negotiation', () => {
  it('asks for a specific version instead of taking the server default', async () => {
    const seen: Seen[] = [];
    await new PaperlessClient(transport(seen)).testConnection();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['accept']).toBe('application/json; version=9');
  });

  it('keeps the version on every request, not just the first', async () => {
    const seen: Seen[] = [];
    const client = new PaperlessClient(transport(seen));
    await client.testConnection();
    await client.listDocuments({ pageSize: 1 });
    await client.getCorrespondents();
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call.headers['accept']).toBe('application/json; version=9');
    }
  });

  it('lets a caller choose the version, for when the pin moves', async () => {
    const seen: Seen[] = [];
    await new PaperlessClient(transport(seen, { apiVersion: 6 })).testConnection();
    expect(seen[0]?.headers['accept']).toBe('application/json; version=6');
  });

  it('keeps the token out of the version header', async () => {
    const seen: Seen[] = [];
    await new PaperlessClient(transport(seen)).testConnection();
    expect(seen[0]?.headers['authorization']).toBe(`Token ${TOKEN}`);
    expect(seen[0]?.headers['accept']).not.toContain(TOKEN);
  });
});