import { describe as suite, expect, it } from 'vitest';
import { PaperlessClient } from '../src/client';
import { joinUrl, redact } from '../src/config';
import type { FetchLike, FormDataLike, HttpRequest, HttpResponse } from '../src/http';

const TOKEN = 'a1b2c3d4e5f6g7h8i9j0';

interface Canned {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

interface Recorded {
  url: string;
  init: HttpRequest | undefined;
}

function harness(plan: Canned | Canned[] | ((url: string) => Canned)) {
  const calls: Recorded[] = [];
  const queue = Array.isArray(plan) ? [...plan] : null;
  let index = 0;

  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const canned = typeof plan === 'function' ? plan(url) : (queue?.[index++] ?? (plan as Canned));
    if (canned.throws !== undefined) return Promise.reject(canned.throws);
    const status = canned.status ?? 200;
    const headers = canned.headers ?? {};
    const response: HttpResponse = {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(canned.body ?? ''),
    };
    return Promise.resolve(response);
  };

  const parts: Array<{ name: string; value: unknown; filename?: string }> = [];
  const formData = (): FormDataLike => ({
    append: (name, value, filename) =>
      parts.push(filename === undefined ? { name, value } : { name, value, filename }),
  });

  return { calls, parts, formData, fetch };
}

const clientFor = (h: ReturnType<typeof harness>, baseUrl = 'https://paperless.example.com') =>
  new PaperlessClient({ baseUrl, token: TOKEN, fetch: h.fetch, formData: h.formData });

suite('joinUrl', () => {
  it('does not care how the user typed their server URL', () => {
    for (const base of [
      'https://p.example.com',
      'https://p.example.com/',
      'https://p.example.com///',
    ]) {
      expect(joinUrl(base, 'api/tasks/')).toBe('https://p.example.com/api/tasks/');
    }
  });

  it('preserves a path prefix, for servers behind a reverse proxy subpath', () => {
    expect(joinUrl('https://home.example.com/paperless/', '/api/tags/')).toBe(
      'https://home.example.com/paperless/api/tags/',
    );
  });
});

suite('authentication', () => {
  it('sends the token in the Paperless header format', async () => {
    const h = harness({ body: '{"results":[]}' });
    await clientFor(h).testConnection();
    expect(h.calls[0]!.init!.headers!['authorization']).toBe(`Token ${TOKEN}`);
    expect(h.calls[0]!.init!.headers!['accept']).toBe('application/json');
  });

  it('hits an authenticated endpoint, so a bad token fails at setup not at upload', async () => {
    const h = harness({ status: 401, body: 'Invalid token.' });
    const result = await clientFor(h).testConnection();
    expect(h.calls[0]!.url).toContain('/api/documents/');
    expect(result).toEqual({ ok: false, reason: { kind: 'auth', status: 401 } });
  });

  it('reports the server version when the connection is healthy', async () => {
    const h = harness({ body: '{"results":[]}', headers: { 'x-version': '2.14.7' } });
    const result = await clientFor(h).testConnection();
    expect(result).toEqual({
      ok: true,
      value: { version: '2.14.7', host: 'paperless.example.com' },
    });
  });
});

suite('token never escapes', () => {
  it('is redacted out of an error body that echoes it back', async () => {
    const h = harness({ status: 400, body: `bad request with Token ${TOKEN} attached` });
    const result = await clientFor(h).testConnection();
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain('[redacted]');
  });

  it('is redacted out of a TLS failure message', async () => {
    const h = harness({
      throws: new Error(`self signed certificate (token ${TOKEN} in flight)`),
    });
    const result = await clientFor(h).testConnection();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('is not exposed by serializing the client', () => {
    const h = harness({});
    const serialized = JSON.stringify(clientFor(h));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain('[redacted]');
  });

  it('is never placed in the URL', async () => {
    const h = harness({ body: '{"results":[]}' });
    const client = clientFor(h);
    await client.testConnection();
    await client.getTask('abc-123');
    await client.getTags();
    for (const call of h.calls) expect(call.url).not.toContain(TOKEN);
  });

  it('redact leaves ordinary text alone and tolerates an empty token', () => {
    expect(redact('nothing secret here', TOKEN)).toBe('nothing secret here');
    expect(redact('anything', '')).toBe('anything');
  });
});

suite('postDocument', () => {
  it('uploads the file under the field Paperless expects, with extra fields', async () => {
    const h = harness({ body: '"3f2b1a-task"' });
    const result = await clientFor(h).postDocument(
      { part: { uri: 'file:///doc.pdf' }, filename: 'scan.pdf' },
      { title: 'Receipt' },
    );
    expect(result).toEqual({ ok: true, value: '3f2b1a-task' });
    expect(h.calls[0]!.init!.method).toBe('POST');
    expect(h.parts).toEqual([
      { name: 'document', value: { uri: 'file:///doc.pdf' }, filename: 'scan.pdf' },
      { name: 'title', value: 'Receipt' },
    ]);
  });

  it('reads the task id however the server chose to wrap it', async () => {
    const cases: Array<[string, string]> = [
      ['"quoted-uuid"', 'quoted-uuid'],
      ['  "padded-uuid"  ', 'padded-uuid'],
      ['bare-uuid-1234', 'bare-uuid-1234'],
      ['{"task_id":"object-uuid"}', 'object-uuid'],
    ];
    for (const [body, expected] of cases) {
      const h = harness({ body });
      const result = await clientFor(h).postDocument({ part: 'x', filename: 'a.pdf' });
      expect(result, body).toEqual({ ok: true, value: expected });
    }
  });

  it('says so plainly when it cannot find a task id', async () => {
    for (const body of ['', '   ', '<html>nope</html>', '{"detail":"weird"}', 'null']) {
      const h = harness({ body });
      const result = await clientFor(h).postDocument({ part: 'x', filename: 'a.pdf' });
      expect(result.ok, body).toBe(false);
      if (!result.ok) expect(result.reason.kind).toBe('rejected');
    }
  });

  it('maps a payload the server will not accept', async () => {
    const h = harness({ status: 413 });
    const result = await clientFor(h).postDocument({ part: 'x', filename: 'a.pdf' });
    expect(result).toEqual({ ok: false, reason: { kind: 'too_large' } });
  });

  it('does not claim failure when the platform simply has no FormData', async () => {
    const h = harness({ body: '"t"' });
    const client = new PaperlessClient({
      baseUrl: 'https://p.example.com',
      token: TOKEN,
      fetch: h.fetch,
      formData: () => {
        throw new Error('no FormData implementation available on this platform');
      },
    });
    const result = await client.postDocument({ part: 'x', filename: 'a.pdf' });
    expect(result.ok).toBe(false);
    // Classified as unreachable, i.e. retryable, rather than as a rejection.
    if (!result.ok) expect(result.reason.kind).toBe('unreachable');
    expect(h.calls).toHaveLength(0);
  });
});

suite('getTask', () => {
  it('finds the matching row in a bare array', async () => {
    const h = harness({
      body: JSON.stringify([
        { task_id: 'other', status: 'SUCCESS' },
        { task_id: 'wanted', status: 'PENDING' },
      ]),
    });
    const result = await clientFor(h).getTask('wanted');
    expect(result).toEqual({ ok: true, value: { task_id: 'wanted', status: 'PENDING' } });
    expect(h.calls[0]!.url).toContain('task_id=wanted');
  });

  it('handles the paginated envelope some versions return', async () => {
    const h = harness({
      body: JSON.stringify({ results: [{ task_id: 'wanted', status: 'SUCCESS' }] }),
    });
    const result = await clientFor(h).getTask('wanted');
    expect(result).toEqual({ ok: true, value: { task_id: 'wanted', status: 'SUCCESS' } });
  });

  it('returns null when the server has forgotten the task', async () => {
    const h = harness({ body: '[]' });
    expect(await clientFor(h).getTask('gone')).toEqual({ ok: true, value: null });
  });

  it('reports a body that is not JSON rather than throwing', async () => {
    const h = harness({ body: '<html>gateway</html>' });
    const result = await clientFor(h).getTask('x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('rejected');
      if (result.reason.kind === 'rejected')
        expect(result.reason.message).toContain('expected JSON');
    }
  });
});

suite('metadata', () => {
  it('sends only the fields that were actually set', async () => {
    const h = harness({ status: 200, body: '{}' });
    await clientFor(h).patchDocument(4821, { title: 'Amazon receipt', tags: [4, 7] });
    expect(h.calls[0]!.init!.method).toBe('PATCH');
    expect(JSON.parse(String(h.calls[0]!.init!.body))).toEqual({
      title: 'Amazon receipt',
      tags: [4, 7],
    });
  });

  it('can clear a field by sending an explicit null', async () => {
    const h = harness({ status: 200, body: '{}' });
    await clientFor(h).patchDocument(1, { correspondent: null });
    expect(JSON.parse(String(h.calls[0]!.init!.body))).toEqual({ correspondent: null });
  });

  it('passes suggestions through as ids for the caller to resolve', async () => {
    const h = harness({ body: '{"correspondents":[3],"tags":[1,2],"document_types":[9]}' });
    const result = await clientFor(h).getSuggestions(4821);
    expect(result).toEqual({
      ok: true,
      value: { correspondents: [3], tags: [1, 2], document_types: [9] },
    });
    expect(h.calls[0]!.url).toContain('/api/documents/4821/suggestions/');
  });
});

suite('vocabulary lists', () => {
  it('follows pagination to the end', async () => {
    const h = harness([
      {
        body: JSON.stringify({
          results: [{ id: 1, name: 'Amazon' }],
          next: 'https://paperless.example.com/api/tags/?page=2',
        }),
      },
      { body: JSON.stringify({ results: [{ id: 2, name: 'Utilities' }], next: null }) },
    ]);
    const result = await clientFor(h).getTags();
    expect(result).toEqual({
      ok: true,
      value: [
        { id: 1, name: 'Amazon' },
        { id: 2, name: 'Utilities' },
      ],
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.url).toBe('https://paperless.example.com/api/tags/?page=2');
  });

  it('stops rather than looping when a server keeps handing back a next page', async () => {
    const h = harness(() => ({
      body: JSON.stringify({
        results: [{ id: 1, name: 'x' }],
        next: 'https://paperless.example.com/api/correspondents/?page=2',
      }),
    }));
    const result = await clientFor(h).getCorrespondents();
    expect(result.ok).toBe(true);
    expect(h.calls.length).toBeLessThanOrEqual(50);
  });

  it('gives up on the whole list if one page fails', async () => {
    const h = harness([
      {
        body: JSON.stringify({
          results: [{ id: 1, name: 'x' }],
          next: 'https://paperless.example.com/api/document_types/?page=2',
        }),
      },
      { status: 503 },
    ]);
    const result = await clientFor(h).getDocumentTypes();
    expect(result).toEqual({ ok: false, reason: { kind: 'server_error', status: 503 } });
  });
});

suite('transport failures', () => {
  it('treats an aborted request as unreachable, so it stays retryable', async () => {
    const h = harness({ throws: new Error('The operation was aborted.') });
    const result = await clientFor(h).testConnection();
    expect(result).toEqual({ ok: false, reason: { kind: 'unreachable' } });
  });

  it('honours Retry-After on a rate limit', async () => {
    const h = harness({ status: 429, headers: { 'retry-after': '45' } });
    const result = await clientFor(h).testConnection();
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'rate_limited', retryAfterMs: 45_000 },
    });
  });
});
