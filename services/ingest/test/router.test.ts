/**
 * The routes, tested as pure functions.
 *
 * The properties here are the ones that used to be workarounds. Idempotency is no
 * longer inferred from the wording of an error message, and "do you already have
 * this?" is no longer a search whose filter might be ignored — both are now just
 * what the protocol says.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { authorization, paths } from '@sheaf/protocol';
import { err, ok } from '@sheaf/http';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Devices } from '../src/devices';
import { nativeArchiveSource } from '../src/native-archive';
import type { ArchiveSource } from '../src/paperless-browse';
import { handle, type IngestRequest } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const TOKEN = 'a-token-of-at-least-16-chars';
const pdf = (marker: string): Uint8Array =>
  new Uint8Array(Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`));

const A = pdf('document-a');
const B = pdf('document-b');
const hashA = sha256Hex(A);
const hashB = sha256Hex(B);

let deps: { storage: Storage; token: string; now: () => number };
let clock = 1_700_000_000_000;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  deps = {
    storage: await Storage.open({
      driver: nodeSqliteDriver(),
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-ingest-')),
    }),
    token: TOKEN,
    now: () => (clock += 1_000),
  };
});

const req = (
  method: string,
  pathAndQuery: string,
  body: Uint8Array = new Uint8Array(),
  headers: Record<string, string | undefined> = {},
): IngestRequest => {
  const [path, query] = pathAndQuery.split('?');
  return {
    method,
    path: path ?? pathAndQuery,
    query: query ?? '',
    headers: { authorization: authorization(TOKEN), ...headers },
    body,
  };
};

suite('idempotency is a property of the address', () => {
  it('stores once, then reports it already had it', async () => {
    const first = await handle(req('PUT', paths.document(hashA), A), deps);
    expect(first.status).toBe(201);

    const second = await handle(req('PUT', paths.document(hashA), A), deps);
    expect(second.status).toBe(200);

    expect(await deps.storage.count()).toBe(1);
  });

  it('survives the case that used to require reading an error message', async () => {
    // The client uploads, the response is lost, the client retries. Previously this
    // meant guessing from a duplicate-rejection string whose wording varied by
    // server version. Now the retry simply gets 200 and stops.
    await handle(req('PUT', paths.document(hashA), A), deps);
    for (let attempt = 0; attempt < 10; attempt++) {
      const retry = await handle(req('PUT', paths.document(hashA), A), deps);
      expect(retry.status).toBe(200);
    }
    expect(await deps.storage.count()).toBe(1);
  });

  it('keeps different documents apart', async () => {
    expect((await handle(req('PUT', paths.document(hashA), A), deps)).status).toBe(201);
    expect((await handle(req('PUT', paths.document(hashB), B), deps)).status).toBe(201);
    expect(await deps.storage.count()).toBe(2);
  });
});

suite('the address is verified, not trusted', () => {
  it('refuses bytes that do not hash to the address they were sent to', async () => {
    const response = await handle(req('PUT', paths.document(hashA), B), deps);
    expect(response.status).toBe(409);
    // Nothing is stored under an identity it does not have.
    expect(await deps.storage.count()).toBe(0);
    expect(await deps.storage.has(hashA)).toBe(false);
  });

  it('catches a truncated upload', async () => {
    const truncated = A.slice(0, A.length - 3);
    const response = await handle(req('PUT', paths.document(hashA), truncated), deps);
    expect(response.status).toBe(409);
    expect(await deps.storage.count()).toBe(0);
  });

  it('refuses an empty body rather than storing nothing under a hash', async () => {
    expect((await handle(req('PUT', paths.document(hashA)), deps)).status).toBe(400);
  });
});

suite('asking whether the server already has it', () => {
  it('answers with a status code, not a search result', async () => {
    expect((await handle(req('HEAD', paths.document(hashA)), deps)).status).toBe(404);
    await handle(req('PUT', paths.document(hashA), A), deps);
    expect((await handle(req('HEAD', paths.document(hashA)), deps)).status).toBe(200);
  });

  it('carries no body, whether found or not', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const found = await handle(req('HEAD', paths.document(hashA)), deps);
    expect(found.bytes).toBeUndefined();
    expect(found.json).toBeUndefined();
  });
});

suite('authentication', () => {
  it('refuses every route without a valid token', async () => {
    const routes: Array<[string, string]> = [
      ['GET', paths.health()],
      ['GET', paths.documents()],
      ['PUT', paths.document(hashA)],
      ['GET', paths.document(hashA)],
      ['HEAD', paths.document(hashA)],
      ['PATCH', paths.document(hashA)],
      ['GET', paths.suggestions(hashA)],
      ['GET', paths.archive()],
    ];
    for (const [method, path] of routes) {
      for (const header of [undefined, 'Bearer wrong', 'Bearer ', 'Token ' + TOKEN]) {
        const response = await handle(
          { method, path, query: '', headers: { authorization: header }, body: A },
          deps,
        );
        expect(response.status, `${method} ${path} with ${String(header)}`).toBe(401);
      }
    }
    expect(await deps.storage.count()).toBe(0);
  });

  it('says nothing about why the token was wrong', async () => {
    const response = await handle(
      {
        method: 'GET',
        path: paths.health(),
        query: '',
        headers: { authorization: 'Bearer wrong' },
        body: new Uint8Array(),
      },
      deps,
    );
    expect(JSON.stringify(response.json)).toBe(JSON.stringify({ error: 'unauthenticated' }));
  });
});

suite('identifiers', () => {
  it('refuses anything that is not a hash, so traversal never reaches the disk', async () => {
    for (const id of ['..', '../../etc/passwd', 'A'.repeat(64), 'abc', `${hashA}.pdf`, '']) {
      const response = await handle(req('GET', `${paths.documents()}/${id}`), deps);
      expect([400, 404], `id ${id}`).toContain(response.status);
    }
  });
});

suite('metadata', () => {
  beforeEach(async () => {
    await handle(req('PUT', paths.document(hashA), A, { 'x-sheaf-page-count': '4' }), deps);
  });

  it('records what the client said about the document', async () => {
    const record = await deps.storage.record(hashA);
    expect(record?.pageCount).toBe(4);
    expect(record?.bytes).toBe(A.length);
    expect(record?.tags).toEqual([]);
  });

  it('applies only the fields present, and clears with null', async () => {
    const body = (patch: unknown) => new Uint8Array(Buffer.from(JSON.stringify(patch)));

    await handle(
      req('PATCH', paths.document(hashA), body({ title: 'Amazon receipt', tags: ['shopping'] })),
      deps,
    );
    let record = await deps.storage.record(hashA);
    expect(record?.title).toBe('Amazon receipt');
    expect(record?.tags).toEqual(['shopping']);

    // Omitted fields survive.
    await handle(req('PATCH', paths.document(hashA), body({ correspondent: 'Amazon' })), deps);
    record = await deps.storage.record(hashA);
    expect(record?.title).toBe('Amazon receipt');
    expect(record?.correspondent).toBe('Amazon');

    // null clears.
    await handle(req('PATCH', paths.document(hashA), body({ title: null })), deps);
    record = await deps.storage.record(hashA);
    expect(record?.title).toBeNull();
    expect(record?.correspondent).toBe('Amazon');
  });

  it('will not patch a document it does not have', async () => {
    const response = await handle(
      req('PATCH', paths.document(hashB), new Uint8Array(Buffer.from('{}'))),
      deps,
    );
    expect(response.status).toBe(404);
  });

  it('refuses a body that is not a JSON object', async () => {
    for (const raw of ['not json', '[1,2]', '"a string"', 'null']) {
      const response = await handle(
        req('PATCH', paths.document(hashA), new Uint8Array(Buffer.from(raw))),
        deps,
      );
      expect(response.status, raw).toBe(400);
    }
  });
});

suite('reading documents back', () => {
  it('returns the exact bytes that were stored', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const response = await handle(req('GET', paths.document(hashA)), deps);
    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(A);
    expect(response.headers?.['content-type']).toBe('application/pdf');
  });

  it('tells apart a document it never had from one retention already freed', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await deps.storage.recordForwardAttempt(hashA, 'paperless', {
      state: 'done',
      attempts: 1,
      nextAt: null,
      error: null,
      doneAt: clock,
    });
    await deps.storage.release(hashA);

    const released = await handle(req('GET', paths.document(hashA)), deps);
    expect(released.status).toBe(410);
    expect((released.json as { error: string }).error).toBe('released');

    const neverHad = await handle(req('GET', paths.document(hashB)), deps);
    expect(neverHad.status).toBe(404);
    expect((neverHad.json as { error: string }).error).toBe('not_found');
  });

  it('lists newest first', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await handle(req('PUT', paths.document(hashB), B), deps);
    const response = await handle(req('GET', paths.documents()), deps);
    const listed = (response.json as { documents: Array<{ sha256: string }> }).documents;
    expect(listed.map((d) => d.sha256)).toEqual([hashB, hashA]);
  });

  it('reports how many it holds', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const response = await handle(req('GET', paths.health()), deps);
    expect(response.json).toEqual({ name: 'sheaf-ingest', protocol: 'v1', documents: 1 });
  });
});

suite('suggestions', () => {
  it('answers null before anything has come back, distinct from an empty answer', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const response = await handle(req('GET', paths.suggestions(hashA)), deps);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ suggestions: null });
  });

  it('serves whatever the fetcher cached, once there is something', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await deps.storage.recordForwardAttempt(hashA, 'paperless', {
      state: 'done',
      attempts: 1,
      nextAt: null,
      remoteId: '4821',
      error: null,
      doneAt: clock,
    });
    await deps.storage.recordSuggestionAttempt(hashA, {
      state: 'done',
      attempts: 1,
      nextAt: null,
      suggestions: { correspondent: 'Amazon', tags: ['shopping'] },
    });

    const response = await handle(req('GET', paths.suggestions(hashA)), deps);
    expect(response.json).toEqual({ suggestions: { correspondent: 'Amazon', tags: ['shopping'] } });

    // And it survives retention freeing the bytes -- suggestions are metadata too.
    await deps.storage.release(hashA);
    expect((await handle(req('GET', paths.suggestions(hashA)), deps)).json).toEqual({
      suggestions: { correspondent: 'Amazon', tags: ['shopping'] },
    });
  });

  it('404s for a document it has never heard of', async () => {
    const response = await handle(req('GET', paths.suggestions(hashB)), deps);
    expect(response.status).toBe(404);
  });

  it('rejects a malformed id the same way the document route does', async () => {
    const response = await handle(req('GET', `${paths.documents()}/not-a-hash/suggestions`), deps);
    expect(response.status).toBe(400);
  });

  it('is read-only', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const response = await handle(req('PUT', paths.suggestions(hashA), A), deps);
    expect(response.status).toBe(400);
  });
});

suite('the reconciliation probe on /v1/health', () => {
  it('says nothing about it when forwarding is not configured', async () => {
    const response = await handle(req('GET', paths.health()), deps);
    expect(response.json).not.toHaveProperty('forwarding');
  });

  it('omits it while the probe has not answered yet', async () => {
    const withForwarding = { ...deps, forwardingTo: 'paperless.example' };
    const response = await handle(req('GET', paths.health()), withForwarding);
    const forwarding = (response.json as { forwarding: Record<string, unknown> }).forwarding;
    expect(forwarding).not.toHaveProperty('reconciliation');
  });

  it('reports what the live getter says, once there is an answer', async () => {
    const probe = { filterSupported: false, conclusive: true, detail: 'the filter was ignored' };
    const withProbe = { ...deps, forwardingTo: 'paperless.example', reconciliation: () => probe };
    const response = await handle(req('GET', paths.health()), withProbe);
    const forwarding = (response.json as { forwarding: Record<string, unknown> }).forwarding;
    expect(forwarding['reconciliation']).toEqual(probe);
  });
});

suite('retention on /v1/health', () => {
  it('says nothing about it when retention is off', async () => {
    const withForwarding = { ...deps, forwardingTo: 'paperless.example' };
    const response = await handle(req('GET', paths.health()), withForwarding);
    const forwarding = (response.json as { forwarding: Record<string, unknown> }).forwarding;
    expect(forwarding).not.toHaveProperty('retention');
  });

  it('reports the configured days and how many documents have actually been released', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await deps.storage.recordForwardAttempt(hashA, 'paperless', {
      state: 'done',
      attempts: 1,
      nextAt: null,
      remoteId: '4821',
      error: null,
      doneAt: clock,
    });
    await deps.storage.release(hashA);

    const withRetention = { ...deps, forwardingTo: 'paperless.example', retentionDays: 30 };
    const response = await handle(req('GET', paths.health()), withRetention);
    const forwarding = (response.json as { forwarding: Record<string, unknown> }).forwarding;
    expect(forwarding['retention']).toEqual({ days: 30, released: 1 });
  });
});

const RESOLVED = {
  id: 4821,
  title: 'Amazon receipt',
  correspondent: 'Amazon',
  documentType: 'Receipt',
  tags: ['shopping'],
  created: '2026-08-22',
  contentSnippet: null,
};

function fakeArchive(): { source: ArchiveSource; calls: string[] } {
  const calls: string[] = [];
  const source: ArchiveSource = {
    search: (query) => {
      calls.push(`search:${JSON.stringify(query)}`);
      return Promise.resolve(
        ok({ documents: [RESOLVED], count: 1, page: query.page ?? 1, hasMore: false }),
      );
    },
    get: (id) => {
      calls.push(`get:${id}`);
      return Promise.resolve(id === RESOLVED.id ? ok(RESOLVED) : err({ kind: 'not_found' }));
    },
    thumbnail: (id) => {
      calls.push(`thumbnail:${id}`);
      return Promise.resolve(ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' }));
    },
    patch: (id, patch) => {
      calls.push(`patch:${id}:${JSON.stringify(patch)}`);
      return Promise.resolve(ok({ ...RESOLVED, title: patch.title ?? RESOLVED.title }));
    },
    vocabulary: () => {
      calls.push('vocabulary');
      return Promise.resolve({
        correspondents: [{ id: 3, name: 'Amazon' }],
        documentTypes: [{ id: 7, name: 'Receipt' }],
        tags: [{ id: 1, name: 'shopping' }],
      });
    },
  };
  return { source, calls };
}

suite('the archive', () => {
  it('refuses to browse when forwarding is not configured', async () => {
    const response = await handle(req('GET', paths.archive()), deps);
    expect(response.status).toBe(503);
    expect((response.json as { error: string }).error).toBe('archive_disabled');
  });

  it('every archive route is disabled the same way, not just the search', async () => {
    for (const [method, path] of [
      ['GET', paths.archive()],
      ['GET', paths.archiveVocabulary()],
      ['GET', paths.archiveDocument(4821)],
      ['GET', paths.archiveThumbnail(4821)],
      ['PATCH', paths.archiveDocument(4821)],
    ] as const) {
      const response = await handle(req(method, path), deps);
      expect(response.status, `${method} ${path}`).toBe(503);
    }
  });

  it('searches, passing the query string through as a structured query', async () => {
    const fake = fakeArchive();
    const withArchive = { ...deps, archive: fake.source };
    const response = await handle(
      req('GET', `${paths.archive()}?query=amazon&page=2&correspondent=3&documentType=7&tag=1`),
      withArchive,
    );
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ documents: [RESOLVED], count: 1, page: 2, hasMore: false });
    expect(fake.calls[0]).toBe(
      'search:{"text":"amazon","page":2,"correspondentId":3,"documentTypeId":7,"tagId":1}',
    );
  });

  it('searches with no filters at all', async () => {
    const fake = fakeArchive();
    const response = await handle(req('GET', paths.archive()), { ...deps, archive: fake.source });
    expect(response.status).toBe(200);
    expect(fake.calls[0]).toBe('search:{}');
  });

  it('serves the vocabulary', async () => {
    const fake = fakeArchive();
    const response = await handle(req('GET', paths.archiveVocabulary()), {
      ...deps,
      archive: fake.source,
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      correspondents: [{ id: 3, name: 'Amazon' }],
      documentTypes: [{ id: 7, name: 'Receipt' }],
      tags: [{ id: 1, name: 'shopping' }],
    });
  });

  it('fetches one document by its downstream id', async () => {
    const fake = fakeArchive();
    const response = await handle(req('GET', paths.archiveDocument(4821)), {
      ...deps,
      archive: fake.source,
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual(RESOLVED);
  });

  it('answers not_found for a document the downstream system does not have', async () => {
    const fake = fakeArchive();
    const response = await handle(req('GET', paths.archiveDocument(1)), {
      ...deps,
      archive: fake.source,
    });
    expect(response.status).toBe(404);
  });

  it('rejects an id that is not a positive integer, before ever asking downstream', async () => {
    const fake = fakeArchive();
    for (const bad of ['0', '-1', 'abc', '4821.5']) {
      const response = await handle(req('GET', `${paths.archive()}/${bad}`), {
        ...deps,
        archive: fake.source,
      });
      expect(response.status, bad).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });

  it('serves a thumbnail with whatever content type the downstream system sent', async () => {
    const fake = fakeArchive();
    const response = await handle(req('GET', paths.archiveThumbnail(4821)), {
      ...deps,
      archive: fake.source,
    });
    expect(response.status).toBe(200);
    expect(response.headers?.['content-type']).toBe('image/webp');
    expect(response.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('patches a document by its downstream id, with ids rather than free text', async () => {
    const fake = fakeArchive();
    const body = new Uint8Array(Buffer.from(JSON.stringify({ title: 'New title' })));
    const response = await handle(req('PATCH', paths.archiveDocument(4821), body), {
      ...deps,
      archive: fake.source,
    });
    expect(response.status).toBe(200);
    expect((response.json as { title: string }).title).toBe('New title');
    expect(fake.calls[0]).toBe('patch:4821:{"title":"New title"}');
  });

  it('refuses a patch body that is not a JSON object', async () => {
    const fake = fakeArchive();
    const response = await handle(
      req('PATCH', paths.archiveDocument(4821), new Uint8Array(Buffer.from('not json'))),
      { ...deps, archive: fake.source },
    );
    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

suite('document text from the phone', () => {
  const json = (value: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(value)));
  const body = (text: string): Uint8Array => json({ source: 'edge', engine: 'apple-vision', text });

  it('stores text for a document it holds, and storing it again changes nothing', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    expect(
      (await handle(req('PUT', paths.documentText(hashA), body('TOTAL 12.50')), deps)).status,
    ).toBe(204);
    expect(
      (await handle(req('PUT', paths.documentText(hashA), body('TOTAL 12.50')), deps)).status,
    ).toBe(204);

    const texts = await deps.storage.texts(hashA);
    expect(texts).toEqual([
      expect.objectContaining({ source: 'edge', engine: 'apple-vision', text: 'TOTAL 12.50' }),
    ]);
  });

  it('leaves the stored text untouched, time included, when the same text is resent', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await handle(req('PUT', paths.documentText(hashA), body('TOTAL 12.50')), deps);
    const before = await deps.storage.texts(hashA);
    await handle(req('PUT', paths.documentText(hashA), body('TOTAL 12.50')), deps);
    expect(await deps.storage.texts(hashA)).toEqual(before);
  });

  it('replaces older text from the same source', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await handle(req('PUT', paths.documentText(hashA), body('first read')), deps);
    await handle(req('PUT', paths.documentText(hashA), body('better read')), deps);
    expect((await deps.storage.texts(hashA)).map((t) => t.text)).toEqual(['better read']);
  });

  it('refuses text for a document it does not hold', async () => {
    const response = await handle(req('PUT', paths.documentText(hashA), body('x')), deps);
    expect(response.status).toBe(404);
  });

  it.each([
    ['not JSON', new Uint8Array(Buffer.from('TOTAL 12.50'))],
    ['the wrong shape', json({ source: 'edge', text: 'no engine' })],
    ['an empty body', new Uint8Array()],
  ])('refuses %s', async (_, payload) => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const response = await handle(req('PUT', paths.documentText(hashA), payload), deps);
    expect(response.status).toBe(400);
  });

  it('refuses text over the limit', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    const huge = body('x'.repeat(1024 * 1024 + 1));
    expect((await handle(req('PUT', paths.documentText(hashA), huge), deps)).status).toBe(413);
  });

  it('allows only PUT', async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    expect((await handle(req('POST', paths.documentText(hashA), body('x')), deps)).status).toBe(
      400,
    );
  });
});

suite('search', () => {
  const textBody = (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(JSON.stringify({ source: 'edge', engine: 'mlkit', text })));

  beforeEach(async () => {
    await handle(req('PUT', paths.document(hashA), A), deps);
    await handle(req('PUT', paths.document(hashB), B), deps);
    await handle(req('PUT', paths.documentText(hashA), textBody('CINEMA CITY total 12.50')), deps);
  });

  it('finds documents by their text, with a marked snippet', async () => {
    const response = await handle(req('GET', `${paths.search()}?q=cinema`), deps);
    expect(response.status).toBe(200);
    const body = response.json as { hits: { sha256: string; snippet: string }[]; hasMore: boolean };
    expect(body.hits.map((hit) => hit.sha256)).toEqual([hashA]);
    expect(body.hits[0]!.snippet).toContain('«CINEMA»');
    expect(body.hasMore).toBe(false);
  });

  it('answers a search that cannot fail with no results, never an error', async () => {
    for (const q of ['', '%3A', 'total%3A%2012.50', '%22', 'NEAR(']) {
      const response = await handle(req('GET', `${paths.search()}?q=${q}`), deps);
      expect(response.status, q).toBe(200);
    }
    const none = await handle(req('GET', `${paths.search()}?q=%21%21`), deps);
    expect(none.json).toEqual({ hits: [], hasMore: false });
  });

  it('pages with limit and offset', async () => {
    await handle(req('PUT', paths.documentText(hashB), textBody('cinema popcorn')), deps);
    const first = await handle(req('GET', `${paths.search()}?q=cinema&limit=1`), deps);
    const second = await handle(req('GET', `${paths.search()}?q=cinema&limit=1&offset=1`), deps);
    expect((first.json as { hasMore: boolean }).hasMore).toBe(true);
    expect((second.json as { hasMore: boolean }).hasMore).toBe(false);
  });

  it.each(['limit=0', 'limit=101', 'limit=ten', 'offset=-1', 'offset=1.5'])(
    'refuses %s',
    async (param) => {
      const response = await handle(req('GET', `${paths.search()}?q=cinema&${param}`), deps);
      expect(response.status).toBe(400);
    },
  );

  it('allows only GET', async () => {
    expect((await handle(req('POST', paths.search()), deps)).status).toBe(400);
  });
});

suite('the archive, served from this server', () => {
  it('lists and searches stored documents, and refuses an edit naming an unknown tag', async () => {
    const native = { ...deps, archive: nativeArchiveSource(deps.storage) };
    await handle(req('PUT', paths.document(hashA), A), native);
    await handle(
      req(
        'PUT',
        paths.documentText(hashA),
        new Uint8Array(
          Buffer.from(JSON.stringify({ source: 'edge', engine: 'mlkit', text: 'CINEMA' })),
        ),
      ),
      native,
    );

    const found = await handle(req('GET', `${paths.archive()}?query=cinema`), native);
    expect(found.status).toBe(200);
    const body = found.json as { documents: { id: number }[]; count: number };
    expect(body.count).toBe(1);

    const id = body.documents[0]!.id;
    const edit = await handle(
      req('PATCH', paths.archiveDocument(id), new Uint8Array(Buffer.from('{"tagIds":[999]}'))),
      native,
    );
    expect(edit.status).toBe(400);
  });
});

suite('pairing and devices', () => {
  const json = (value: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(value)));
  const as = (token: string, method: string, path: string, body?: Uint8Array): IngestRequest => ({
    ...req(method, path, body),
    headers: { authorization: `Bearer ${token}` },
  });
  const anonymous = (method: string, path: string, body?: Uint8Array): IngestRequest => ({
    ...req(method, path, body),
    headers: {},
    remoteAddress: '192.168.1.50',
  });

  let paired: { deps: typeof deps & { devices: Devices }; token: string; deviceId: string };

  beforeEach(async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-pair-')),
    });
    const withDevices = { ...deps, storage, devices: new Devices(driver, { now: () => clock }) };
    const created = await handle(req('POST', paths.pairingCodes()), withDevices);
    const { code } = created.json as { code: string };
    const response = await handle(
      anonymous('POST', paths.pair(), json({ code, deviceName: 'Test phone' })),
      withDevices,
    );
    const body = response.json as { token: string; deviceId: string };
    paired = { deps: withDevices, token: body.token, deviceId: body.deviceId };
  });

  it('lets a paired phone upload, and records which phone it was', async () => {
    const response = await handle(as(paired.token, 'PUT', paths.document(hashA), A), paired.deps);
    expect(response.status).toBe(201);
    expect(await paired.deps.storage.deviceOf(hashA)).toBe(paired.deviceId);
  });

  it('keeps device management to the admin token', async () => {
    for (const [method, path] of [
      ['POST', paths.pairingCodes()],
      ['GET', paths.devices()],
      ['DELETE', paths.device(paired.deviceId)],
    ] as const) {
      const response = await handle(as(paired.token, method, path), paired.deps);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lists devices for the admin, and revokes one', async () => {
    const list = await handle(req('GET', paths.devices()), paired.deps);
    expect((list.json as { devices: { name: string }[] }).devices.map((d) => d.name)).toEqual([
      'Test phone',
    ]);
    expect((await handle(req('DELETE', paths.device(paired.deviceId)), paired.deps)).status).toBe(
      204,
    );
    expect((await handle(req('DELETE', paths.device('nope')), paired.deps)).status).toBe(404);

    const after = await handle(as(paired.token, 'GET', paths.health()), paired.deps);
    expect(after.status).toBe(401);
    expect((after.json as { error: string }).error).toBe('device_revoked');
  });

  it('refuses a code used twice, an unknown code, and a malformed request alike', async () => {
    const created = await handle(req('POST', paths.pairingCodes()), paired.deps);
    const { code } = created.json as { code: string };
    const pair = (body: unknown) =>
      handle(anonymous('POST', paths.pair(), json(body)), paired.deps);

    expect((await pair({ code, deviceName: 'A' })).status).toBe(200);
    for (const body of [
      { code, deviceName: 'B' },
      { code: 'ZZZZ', deviceName: 'C' },
    ]) {
      expect(((await pair(body)).json as { error: string }).error).toBe('pairing_invalid');
    }
    expect((await pair({ deviceName: 'no code' })).status).toBe(400);
  });

  it('slows down someone guessing codes', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await handle(
          anonymous('POST', paths.pair(), json({ code: 'X', deviceName: 'G' })),
          paired.deps,
        )
      ).status;
    }
    expect(last).toBe(429);
  });

  it('still accepts the admin token everywhere, so existing installs keep working', async () => {
    expect((await handle(req('PUT', paths.document(hashB), B), paired.deps)).status).toBe(201);
    expect(await paired.deps.storage.deviceOf(hashB)).toBeNull();
  });
});
