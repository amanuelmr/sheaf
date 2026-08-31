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
import { nodeSqliteDriver } from '@sheaf/store/node';
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
  path: string,
  body: Uint8Array = new Uint8Array(),
  headers: Record<string, string | undefined> = {},
): IngestRequest => ({
  method,
  path,
  headers: { authorization: authorization(TOKEN), ...headers },
  body,
});

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
    ];
    for (const [method, path] of routes) {
      for (const header of [undefined, 'Bearer wrong', 'Bearer ', 'Token ' + TOKEN]) {
        const response = await handle(
          { method, path, headers: { authorization: header }, body: A },
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
    await deps.storage.recordForwardAttempt(hashA, {
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
    await deps.storage.recordForwardAttempt(hashA, {
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
