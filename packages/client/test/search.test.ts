import { describe as suite, expect, it } from 'vitest';
import type { HttpResponse } from '@sheaf/http';
import { SheafClient } from '../src/client';

function clientReturning(body: unknown) {
  const urls: string[] = [];
  const client = new SheafClient({
    baseUrl: 'http://sheaf.local:8787',
    token: 'a-token-of-at-least-16-chars',
    fetch: (url) => {
      urls.push(url);
      const response: HttpResponse = {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(body)),
      };
      return Promise.resolve(response);
    },
  });
  return { client, urls };
}

suite('searchDocuments', () => {
  it('sends the text encoded, so it reaches the server exactly as typed', async () => {
    const { client, urls } = clientReturning({ hits: [], hasMore: false });
    await client.searchDocuments('total: 12.50 & tip', { limit: 5, offset: 10 });
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('q')).toBe('total: 12.50 & tip');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('offset')).toBe('10');
  });

  it('returns the server’s hits', async () => {
    const hit = { sha256: 'a'.repeat(64), title: 'Receipt', snippet: '«total»' };
    const { client } = clientReturning({ hits: [hit], hasMore: true });
    const result = await client.searchDocuments('total');
    expect(result).toEqual({ ok: true, value: { hits: [hit], hasMore: true } });
  });
});
