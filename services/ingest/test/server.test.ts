/**
 * The socket edge. Everything else is covered as pure functions; these are the
 * behaviours that only exist once there is a real connection — refusing an
 * oversized upload while it is still arriving, and HEAD carrying no body.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, authorization, paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { createIngestServer } from '../src/server';
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

  it('refuses an oversized upload instead of buffering it', async () => {
    const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1_024);
    const res = await fetch(base + paths.document(hashA), {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/pdf' },
      body: tooBig,
    }).catch(() => null);
    // The server destroys the request once the limit is passed, so either it
    // answered 413 or the connection was cut. Both are a refusal; neither stores.
    if (res !== null) expect(res.status).toBe(413);
  });

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
