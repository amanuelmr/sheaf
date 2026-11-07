/** Saved views: filters kept under a name, some of them on the dashboard. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { Storage } from '../src/storage';
import { SavedViews } from '../src/views';

const TOKEN = 'admin-token-for-views';
const NOW = 1_700_000_000_000;
let views: SavedViews;
let deps: Parameters<typeof handle>[1];

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-v-')),
  });
  views = new SavedViews(driver);
  deps = { storage, token: TOKEN, now: () => NOW, views };
});

const req = (method: string, path: string, body?: unknown): IngestRequest => ({
  method,
  path,
  query: '',
  headers: { authorization: `Bearer ${TOKEN}` },
  body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

suite('saved views', () => {
  it('lists dashboard views first in their order, then the rest by name', async () => {
    await views.create({ name: 'Zeta', filter: {} }, NOW);
    await views.create({ name: 'Unpaid', filter: { tags: ['bills'] }, onDashboard: true }, NOW);
    await views.create({ name: 'alpha', filter: {} }, NOW);
    await views.create({ name: 'Inbox', filter: { tags: ['unread'] }, onDashboard: true }, NOW);
    expect((await views.list()).map((v) => v.name)).toEqual(['Unpaid', 'Inbox', 'alpha', 'Zeta']);

    const inbox = (await views.list())[1]!;
    await views.update(inbox.id, { position: -1 });
    expect((await views.list()).map((v) => v.name).slice(0, 2)).toEqual(['Inbox', 'Unpaid']);
  });

  it('keeps names unique whatever their case', async () => {
    await views.create({ name: 'Bills', filter: {} }, NOW);
    expect(await views.create({ name: 'bills', filter: {} }, NOW)).toMatchObject({
      kind: 'conflict',
    });
  });

  it('is served under /v1/views', async () => {
    const created = await handle(
      req('POST', paths.views(), {
        name: 'Unpaid',
        filter: { tags: ['bills'] },
        onDashboard: true,
      }),
      deps,
    );
    expect(created.status).toBe(201);
    const { id } = created.json as { id: number };
    expect(
      (await handle(req('POST', paths.views(), { name: 'Unpaid', filter: {} }), deps)).status,
    ).toBe(409);
    expect(
      (await handle(req('POST', paths.views(), { name: 'x', filter: { sort: 'no' } }), deps))
        .status,
    ).toBe(400);

    const renamed = await handle(req('PATCH', paths.view(id), { name: 'Open bills' }), deps);
    expect(renamed.json).toMatchObject({ name: 'Open bills', filter: { tags: ['bills'] } });
    expect((await handle(req('GET', paths.views()), deps)).json).toMatchObject({
      views: [{ id, onDashboard: true }],
    });
    expect((await handle(req('DELETE', paths.view(id)), deps)).status).toBe(204);
    expect((await handle(req('GET', paths.view(id)), deps)).status).toBe(404);
    expect((await handle(req('GET', `${paths.views()}/x`), deps)).status).toBe(400);
  });
});
