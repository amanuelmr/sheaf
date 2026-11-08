/** Putting recognised text inside a PDF, so other apps find it by its words. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle } from '../src/router';
import { searchablePdf } from '../src/pdf-edit';
import { Storage, sha256Hex } from '../src/storage';
import { labelled, names } from './pdf-helpers';

/** The drawing instructions of every page, decompressed. */
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

suite('searchable PDFs', () => {
  it('lays the text invisibly over the pages in order, leaving the pages as they were', async () => {
    const source = await labelled('a', 'b');
    const out = await searchablePdf(
      source,
      'Invoice 2093\nCity Power\n\nTotal due 41.20\nThank you',
    );
    expect(await names(out)).toEqual(['a', 'b']);
    const ops = drawn(out);
    expect(ops).toContain('3 Tr');
    for (const line of ['Invoice 2093', 'City Power', 'Total due 41.20', 'Thank you']) {
      expect(ops).toContain(`<${hex(line)}> Tj`);
    }
  });

  it('turns characters the font cannot carry into spaces rather than failing', async () => {
    const out = await searchablePdf(await labelled('a'), 'Résumé 東京 ok');
    expect(drawn(out)).toContain(`<${hex('Résumé ok')}> Tj`);
  });

  it('serves the stored file unchanged when there is no text', async () => {
    const storage = await Storage.open({
      driver: nodeSqliteDriver(),
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-searchable-')),
    });
    const source = await labelled('a');
    const sha = sha256Hex(source);
    await storage.put(sha, source, 1, 1);
    const get = () =>
      handle(
        {
          method: 'GET',
          path: paths.documentSearchable(sha),
          query: '',
          headers: { authorization: 'Bearer admin-token-searchable' },
          body: new Uint8Array(),
        },
        { storage, token: 'admin-token-searchable', now: () => 1 },
      );
    expect((await get()).bytes).toEqual(source);
    await storage.putText(sha, { source: 'edge', engine: 'x', text: 'Water bill March' }, 1);
    const withText = (await get()).bytes!;
    expect(drawn(withText)).toContain(`<${hex('Water bill March')}> Tj`);
    expect(storage.bytes(sha)).toEqual(source);
  });
});
