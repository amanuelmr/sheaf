/** Settings an admin changes while the server runs: saved, then environment, then default. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { Settings } from '../src/settings';
import { Storage } from '../src/storage';
import { TrashSweeper } from '../src/trash';

const TOKEN = 'admin-token-for-settings';
const NOW = 1_700_000_000_000;

const req = (method: string, body?: unknown): IngestRequest => ({
  method,
  path: paths.settings(),
  query: '',
  headers: { authorization: `Bearer ${TOKEN}` },
  body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

suite('settings', () => {
  it('take a saved value over the environment, and forget it on null', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-st-')),
    });
    const settings = await Settings.open(driver, { trashDays: 7 });
    const deps = { storage, token: TOKEN, now: () => NOW, settings };

    expect((await handle(req('GET'), deps)).json).toMatchObject({
      settings: { trashDays: 7, barcodesEnabled: false, barcodeSeparator: 'PATCHT' },
      sources: { trashDays: 'environment', barcodesEnabled: 'default' },
    });
    const saved = await handle(req('PATCH', { trashDays: 14, barcodesEnabled: true }), deps);
    expect(saved.json).toMatchObject({
      settings: { trashDays: 14, barcodesEnabled: true },
      sources: { trashDays: 'saved' },
    });
    // Still there after a restart.
    expect((await Settings.open(driver, { trashDays: 7 })).current().trashDays).toBe(14);
    await handle(req('PATCH', { trashDays: null }), deps);
    expect(settings.current().trashDays).toBe(7);

    expect((await handle(req('PATCH', { trashDays: 0 }), deps)).status).toBe(400);
    expect((await handle(req('PATCH', { filenameFormat: '{{owner}}' }), deps)).status).toBe(400);
    expect((await handle(req('PATCH', { colour: 'red' }), deps)).status).toBe(400);
  });

  it('change how long the trash keeps things without a restart', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-st2-')),
    });
    const settings = await Settings.open(driver, {});
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\nx\n%%EOF\n'));
    const { sha256Hex } = await import('../src/storage');
    await storage.put(sha256Hex(pdf), pdf, NOW, 1);
    await storage.trash(sha256Hex(pdf), NOW);
    const sweeper = new TrashSweeper(storage, () => settings.current().trashDays * 86_400_000, {
      now: () => NOW + 2 * 86_400_000,
    });
    expect(await sweeper.tick()).toEqual({ purged: 0 });
    await settings.update({ trashDays: 1 }, NOW);
    expect(await sweeper.tick()).toEqual({ purged: 1 });
  });
});
