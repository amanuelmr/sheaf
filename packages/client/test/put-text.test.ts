import { describe as suite, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '@sheaf/http';
import { SheafClient } from '../src/client';

const HASH = 'b'.repeat(64);
const TOKEN = 'a-token-of-at-least-16-chars';

function respond(status: number, body = ''): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  };
}

function clientAnswering(status: number, body = '') {
  const calls: { url: string; init: HttpRequest | undefined }[] = [];
  const client = new SheafClient({
    baseUrl: 'http://sheaf.local:8787',
    token: TOKEN,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond(status, body));
    },
  });
  return { client, calls };
}

suite('putText', () => {
  it('sends the text as JSON to the document’s text address', async () => {
    const { client, calls } = clientAnswering(204);
    const result = await client.putText(HASH, {
      source: 'edge',
      engine: 'mlkit',
      text: 'TOTAL 12.50',
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(calls[0]!.url).toBe(`http://sheaf.local:8787/v1/documents/${HASH}/text`);
    expect(calls[0]!.init!.method).toBe('PUT');
    expect(calls[0]!.init!.headers!['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      source: 'edge',
      engine: 'mlkit',
      text: 'TOTAL 12.50',
    });
  });

  it('reports a document the server does not hold as not found', async () => {
    const { client } = clientAnswering(404, '{"error":"not_found"}');
    const result = await client.putText(HASH, { source: 'edge', engine: 'mlkit', text: 'x' });
    expect(result).toEqual({ ok: false, reason: { kind: 'not_found' } });
  });

  it('keeps a server error retryable, and never lets the token into it', async () => {
    const { client } = clientAnswering(503, `upstream said ${TOKEN}`);
    const result = await client.putText(HASH, { source: 'edge', engine: 'mlkit', text: 'x' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
