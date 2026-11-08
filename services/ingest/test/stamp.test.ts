/** Stamping a document, the way a rubber stamp marks paper. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe as suite, expect, it } from 'vitest';
import { paths, stampProblem } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { DocumentEdits } from '../src/document-edits';
import { editPages, unrotate } from '../src/pdf-edit';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';
import { labelled, names, turns } from './pdf-helpers';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const TOKEN = 'admin-token-for-stamps';

/** Every drawing instruction in the file, compressed or not. */
function drawn(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('latin1');
  let out = '';
  for (const match of text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const raw = Buffer.from(match[1]!, 'latin1');
    try {
      out += inflateSync(raw).toString('latin1');
    } catch {
      out += raw.toString('latin1');
    }
  }
  return out;
}

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

suite('turning a shown point back into page coordinates', () => {
  it('keeps every shown corner on the page, whichever way it is turned', () => {
    const [w, h] = [200, 300];
    for (const rotation of [0, 90, 180, 270]) {
      const [sw, sh] = rotation % 180 === 0 ? [w, h] : [h, w];
      for (const [x, y] of [
        [0, 0],
        [sw, 0],
        [0, sh],
        [sw, sh],
      ] as const) {
        const p = unrotate(x, y, w, h, rotation);
        expect([0, w]).toContain(p.x);
        expect([0, h]).toContain(p.y);
      }
    }
    // Shown top-left on a page turned a quarter clockwise is the page's own bottom-left.
    expect(unrotate(0, 200, 200, 300, 90)).toEqual({ x: 0, y: 0 });
  });
});

suite('stamping a document', () => {
  it('draws the words and the date, keeps the pages, and keeps the old file as a version', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-stamp-')),
    });
    const deps = {
      storage,
      token: TOKEN,
      now: () => NOW,
      edits: new DocumentEdits(storage, driver),
    };
    const source = await editPages(await labelled('a', 'b'), [
      { page: 1 },
      { page: 2, rotate: 90 },
    ]);
    const sha = sha256Hex(source);
    await storage.put(sha, source, NOW, 2);
    const post = (body: unknown) =>
      handle(
        {
          method: 'POST',
          path: paths.documentStamp(sha),
          query: '',
          headers: { authorization: `Bearer ${TOKEN}` },
          body: new Uint8Array(Buffer.from(JSON.stringify(body))),
        },
        deps,
      );

    expect((await post({ text: 'Paid', pages: 'all', colour: 'blue' })).status).toBe(200);
    const record = (await storage.list())[0]!;
    expect(record.sha256).not.toBe(sha);
    const stamped = storage.bytes(record.sha256)!;
    expect(await names(stamped)).toEqual(['a', 'b']);
    expect(await turns(stamped)).toEqual([0, 90]);
    const ops = drawn(stamped);
    expect(ops.split(`<${hex('PAID')}> Tj`).length - 1).toBe(2);
    expect(ops).toContain(`<${hex('2026-11-08')}> Tj`);
    expect((await storage.versions(record.sha256)).map((v) => v.sha256)).toEqual([sha]);
  });

  it('refuses words its font cannot draw, and fields it does not know', () => {
    expect(stampProblem({ text: 'Оплачено' })).toMatch(/Latin/);
    expect(stampProblem({ text: '' })).toMatch(/1 to 40/);
    expect(stampProblem({ text: 'OK', size: 3 })).toMatch(/unknown field "size"/);
    expect(stampProblem({ text: 'Reçu', position: 'top-left', colour: 'green' })).toBeNull();
  });
});
