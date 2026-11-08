/** How often suggestions were right, judged by what people kept. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const NOW = 1_700_000_000_000;

suite('suggestion accuracy', () => {
  it('counts a kept suggestion right, a changed one wrong, and an untouched field not at all', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-acc-')),
    });
    const suggest = async (name: string, suggestions: object) => {
      const bytes = pdf(name);
      await storage.put(sha256Hex(bytes), bytes, NOW, 1);
      await driver.run('UPDATE documents SET suggestions_json = ? WHERE sha256 = ?', [
        JSON.stringify(suggestions),
        sha256Hex(bytes),
      ]);
      return sha256Hex(bytes);
    };
    const a = await suggest('a', {
      title: 'Power bill',
      date: '2026-03-01',
      tags: ['Bills', 'home'],
    });
    const b = await suggest('b', { title: 'Water', date: '2026-01-02' });
    await suggest('c', { title: 'Never looked at' });
    await storage.patch(
      a,
      { title: 'power bill ', created: '2026-03-01', tags: ['home', 'bills'] },
      NOW,
    );
    await storage.patch(b, { title: 'Water bill Q1', created: '2026-02-01' }, NOW + 1);

    const response = await handle(
      {
        method: 'GET',
        path: paths.accuracy(),
        query: '',
        headers: { authorization: 'Bearer admin-token-accuracy' },
        body: new Uint8Array(),
      },
      { storage, token: 'admin-token-accuracy', now: () => NOW },
    );
    expect(response.json).toEqual({
      window: 50,
      fields: [
        { field: 'title', right: 1, judged: 2 },
        { field: 'date', right: 1, judged: 2 },
        { field: 'correspondent', right: 0, judged: 0 },
        { field: 'documentType', right: 0, judged: 0 },
        { field: 'tags', right: 1, judged: 1 },
      ],
    });
  });
});
