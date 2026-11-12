/**
 * The socket edge. Everything else is covered as pure functions; these are the
 * behaviours that only exist once there is a real connection — refusing an
 * oversized upload while it is still arriving, and HEAD carrying no body.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, authorization, paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import type { Logger } from '../src/log';
import { ANONYMOUS_BODY_BYTES, createIngestServer, routeOf } from '../src/server';
import { Storage, sha256Hex } from '../src/storage';

const TOKEN = 'a-token-of-at-least-16-chars';
const A = new Uint8Array(Buffer.from('%PDF-1.4\nover-the-wire\n%%EOF\n'));
const hashA = sha256Hex(A);

let server: Server;
let base: string;

beforeAll(async () => {
  const storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-ingest-http-')),
  });
  server = createIngestServer({ storage, token: TOKEN, now: () => 1_700_000_000_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const auth = { authorization: authorization(TOKEN) };

suite('over a real connection', () => {
  it('answers health', async () => {
    const res = await fetch(base + paths.health(), { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'sheaf-ingest', protocol: 'v1' });
  });

  it('stores once and reports the second attempt as already held', async () => {
    const put = () =>
      fetch(base + paths.document(hashA), {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/pdf' },
        body: A,
      });
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(200);
  });

  it('returns the exact bytes back', async () => {
    const res = await fetch(base + paths.document(hashA), { headers: auth });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(A);
  });

  it('sends no body for HEAD, but the same status a GET would give', async () => {
    const res = await fetch(base + paths.document(hashA), { method: 'HEAD', headers: auth });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(0);
  });

  it('answers an oversized upload with 413, not a cut connection', async () => {
    const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1_024);
    const res = await fetch(base + paths.document(hashA), {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/pdf' },
      body: tooBig,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
  });

  it('answers 413 to an oversized upload that does not say its size, too', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        base + paths.document(hashA),
        { method: 'PUT', headers: { ...auth, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const more = () => {
        while (sent <= MAX_DOCUMENT_BYTES) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once('drain', more);
        }
        req.end();
      };
      more();
    });
    expect(status).toBe(413);
  });

  it('reads no large body from a caller without a valid token', async () => {
    const big = new Uint8Array(ANONYMOUS_BODY_BYTES + 1);
    for (const headers of [{}, { authorization: authorization('not-the-right-token-at-all') }]) {
      const res = await fetch(base + paths.document(hashA), { method: 'PUT', headers, body: big });
      expect(res.status).toBe(401);
    }
    const sha = sha256Hex(big);
    expect((await fetch(base + paths.document(sha), { headers: auth })).status).toBe(404);
  });

  it('answers a stranger who announces a large body without waiting for it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        base + paths.document(hashA),
        { method: 'PUT', headers: { 'content-length': String(MAX_DOCUMENT_BYTES) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(401);
  }, 2_000);

  it('refuses an unauthenticated request', async () => {
    const res = await fetch(base + paths.health());
    expect(res.status).toBe(401);
  });

  it('404s an unknown path without revealing anything', async () => {
    const res = await fetch(`${base}/v1/nope`, { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('ignores a query string when routing', async () => {
    const res = await fetch(`${base}${paths.health()}?cache=0`, { headers: auth });
    expect(res.status).toBe(200);
  });
});

suite('CORS', () => {
  it('answers a preflight without ever reaching the router, so no auth is required', async () => {
    const res = await fetch(base + paths.health(), {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('gives every answer its own request id', async () => {
    const one = await fetch(base + paths.health(), { headers: auth });
    const two = await fetch(base + paths.health());
    expect(one.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(two.headers.get('x-request-id')).not.toBe(one.headers.get('x-request-id'));
  });

  it('carries the same headers on a real response, success or failure', async () => {
    const ok = await fetch(base + paths.health(), { headers: auth });
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');

    const unauthenticated = await fetch(base + paths.health());
    expect(unauthenticated.headers.get('access-control-allow-origin')).toBe('*');
  });
});

suite('when something goes wrong inside', () => {
  it('logs the failure under the id the client is given, and tells the client nothing more', async () => {
    const logged: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const logger: Logger = {
      info: () => undefined,
      error: (message, fields) => logged.push({ message, fields }),
    };
    const broken = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('disk on fire');
        },
      },
    );
    const failing = createIngestServer(
      { storage: broken as Storage, token: TOKEN, now: () => 1_700_000_000_000 },
      undefined,
      logger,
    );
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(
        `http://127.0.0.1:${String((failing.address() as AddressInfo).port)}${paths.document(hashA)}`,
        { headers: auth },
      );
      expect(res.status).toBe(500);
      const requestId = res.headers.get('x-request-id');
      expect(await res.json()).toEqual({ error: 'server_error', requestId });
      expect(logged).toEqual([
        {
          message: 'request failed',
          fields: { requestId, method: 'GET', route: '/v1/documents/:id', error: 'disk on fire' },
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it('logs routes without ids, hashes or share-link secrets', () => {
    expect(routeOf(paths.document(hashA))).toBe('/v1/documents/:id');
    expect(routeOf('/share/abcdefghijk')).toBe('/share/:id');
    expect(routeOf('/v1/workflows/12')).toBe('/v1/workflows/:id');
    expect(routeOf('/v1/search')).toBe('/v1/search');
  });
});
