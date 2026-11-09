/** Keeping a copy of every document in an S3 bucket. */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Forwarder } from '../src/forwarder';
import { s3Target, signS3 } from '../src/s3-target';
import { Storage, sha256Hex } from '../src/storage';

const NOW = Date.parse('2026-11-09T10:00:00Z');
const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));

let open: Server | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

suite('signing S3 requests', () => {
  it("gives the signature in AWS's own worked example", () => {
    // "Example: GET Object" in the Signature Version 4 documentation for S3.
    const headers = signS3({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });
});

suite('copying documents to an S3 bucket', () => {
  it('puts each document under its hash, once, in a bucket addressed by path', async () => {
    const objects = new Map<string, Buffer>();
    const log: string[] = [];
    const server = createServer((req, res) => {
      log.push(`${req.method!} ${req.url!}`);
      if (!/^AWS4-HMAC-SHA256 Credential=key-id\//.test(req.headers.authorization ?? '')) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.method === 'PUT') {
          const claimed = req.headers['x-amz-content-sha256'];
          if (claimed !== sha256Hex(new Uint8Array(body))) {
            res.writeHead(400).end();
            return;
          }
          objects.set(req.url!, body);
          res.writeHead(200).end();
        } else res.writeHead(objects.has(req.url!) ? 200 : 404).end();
      });
    });
    open = server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const storage = await Storage.open({
      driver: nodeSqliteDriver(),
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-s3-')),
    });
    const bytes = pdf('march');
    const sha = sha256Hex(bytes);
    await storage.put(sha, bytes, NOW, 1);
    const target = s3Target({
      bucket: 'papers',
      region: 'eu-central-1',
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
      endpoint,
      prefix: 'sheaf/',
    });
    const forwarder = new Forwarder(storage, target, { now: () => NOW, jitter: () => 0 });
    await forwarder.tick();
    await forwarder.tick();

    const key = `/papers/sheaf/${sha.slice(0, 2)}/${sha}.pdf`;
    expect(objects.get(key)).toEqual(Buffer.from(bytes));
    expect((await storage.history(sha)).map((e) => e.text)).toContain('Delivered to s3');
    expect(await target.locate!(sha)).toEqual({
      ok: true,
      value: `sheaf/${sha.slice(0, 2)}/${sha}.pdf`,
    });
    const puts = log.filter((l) => l.startsWith('PUT')).length;
    await forwarder.tick();
    expect(log.filter((l) => l.startsWith('PUT')).length).toBe(puts);
  });
});
