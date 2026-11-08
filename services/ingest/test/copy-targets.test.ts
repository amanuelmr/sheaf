/** Sending copies of documents to a WebDAV server or a folder. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe as suite, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { folderTarget } from '../src/folder-target';
import { Forwarder, type Connector } from '../src/forwarder';
import { Storage, sha256Hex } from '../src/storage';
import { webdavTarget } from '../src/webdav-target';

const NOW = Date.parse('2026-11-08T10:00:00Z');
const FORMAT = '{{correspondent}}/{{title}}';
const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));

/** Enough of a WebDAV server: folders must exist before files go in them. */
function fakeDav(): Promise<{
  server: Server;
  url: string;
  files: Map<string, Buffer>;
  log: string[];
}> {
  const files = new Map<string, Buffer>();
  const folders = new Set(['/dav/']);
  const log: string[] = [];
  const answer = (method: string, path: string, parent: string, body: Buffer): number => {
    if (method === 'MKCOL') {
      if (folders.has(path)) return 405;
      if (!folders.has(parent)) return 409;
      folders.add(path);
      return 201;
    }
    if (method === 'PUT') {
      if (!folders.has(parent)) return 409;
      files.set(path, body);
      return 201;
    }
    if (method === 'HEAD') return files.has(path) ? 200 : 404;
    return 405;
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? '');
    log.push(`${req.method!} ${path}`);
    if (req.headers.authorization !== `Basic ${Buffer.from('ann:secret').toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    const parent = path.replace(/[^/]+\/?$/, '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(answer(req.method ?? '', path, parent, Buffer.concat(chunks))).end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        server,
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/dav/`,
        files,
        log,
      }),
    ),
  );
}

let open: Server | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

async function twoBills() {
  const storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-copy-')),
  });
  const [a, b] = [pdf('march'), pdf('april')];
  for (const bytes of [a, b]) {
    await storage.put(sha256Hex(bytes), bytes, NOW, 1);
    await storage.patch(sha256Hex(bytes), { title: 'Power bill', correspondent: 'City Power' });
  }
  return { storage, a, b };
}

async function deliver(storage: Storage, target: Connector): Promise<void> {
  const forwarder = new Forwarder(storage, target, { now: () => NOW, jitter: () => 0 });
  await forwarder.tick();
  await forwarder.tick();
}

suite('copying documents to a WebDAV server', () => {
  it('makes the folders, puts each file under its own name, and counts it delivered', async () => {
    const dav = await fakeDav();
    open = dav.server;
    const { storage, a, b } = await twoBills();
    const target = webdavTarget({
      url: dav.url,
      username: 'ann',
      password: 'secret',
      filenameFormat: () => FORMAT,
      record: (sha) => storage.record(sha),
    });
    await deliver(storage, target);
    expect([...dav.files.keys()].sort()).toEqual(
      [
        `/dav/City Power/Power bill ${sha256Hex(a).slice(0, 8)}.pdf`,
        `/dav/City Power/Power bill ${sha256Hex(b).slice(0, 8)}.pdf`,
      ].sort(),
    );
    expect(dav.files.get(`/dav/City Power/Power bill ${sha256Hex(a).slice(0, 8)}.pdf`)).toEqual(
      Buffer.from(a),
    );
    expect((await storage.history(sha256Hex(a))).map((e) => e.text)).toContain(
      'Delivered to webdav',
    );
    // Delivered once: nothing more is sent on the next pass.
    const before = dav.log.length;
    await deliver(storage, target);
    expect(dav.log.slice(before).filter((l) => l.startsWith('PUT'))).toEqual([]);
  });

  it('keeps trying with a wrong password rather than counting it delivered', async () => {
    const dav = await fakeDav();
    open = dav.server;
    const { storage, a } = await twoBills();
    await deliver(
      storage,
      webdavTarget({
        url: dav.url,
        username: 'ann',
        password: 'wrong',
        filenameFormat: () => FORMAT,
        record: (sha) => storage.record(sha),
      }),
    );
    expect(dav.files.size).toBe(0);
    expect((await storage.history(sha256Hex(a))).map((e) => e.text)).not.toContain(
      'Delivered to webdav',
    );
  });
});

suite('copying documents to a folder', () => {
  it('writes each document into the folder by its file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheaf-folder-'));
    const { storage, a } = await twoBills();
    await deliver(
      storage,
      folderTarget({ dir, filenameFormat: () => FORMAT, record: (sha) => storage.record(sha) }),
    );
    const file = join(dir, 'City Power', `Power bill ${sha256Hex(a).slice(0, 8)}.pdf`);
    expect(new Uint8Array(readFileSync(file))).toEqual(a);
    expect((await storage.history(sha256Hex(a))).map((e) => e.text)).toContain(
      'Delivered to folder',
    );
  });
});
