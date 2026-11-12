/** Serial numbers in separate series, one per binder or household. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { asnFromLabel, asnLabel, paths, type AsnSeries } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { AsnSeriesStore } from '../src/asn-series';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const TOKEN = 'admin-token-asn-series';
const NOW = 1_700_000_000_000;

async function server() {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-asn-')),
  });
  const deps = { storage, asnSeries: new AsnSeriesStore(driver), token: TOKEN, now: () => NOW };
  const call = async (method: string, path: string, body?: unknown, query = '') => {
    const response = await handle(
      {
        method,
        path,
        query,
        headers: { authorization: `Bearer ${TOKEN}` },
        body: new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
      },
      deps,
    );
    return { status: response.status, json: response.json as Record<string, unknown> };
  };
  const add = async (text: string, asn: number) => {
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`));
    await storage.put(sha256Hex(bytes), bytes, NOW, 1);
    await storage.patch(sha256Hex(bytes), { asn });
  };
  return { call, add };
}

suite('serial number series', () => {
  it('numbers each series from 1, apart from the main one', async () => {
    const { call, add } = await server();
    await add('one', 1);
    await add('two', 2);
    const created = await call('POST', paths.asnSeries(), { prefix: 'B', name: 'Business' });
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ prefix: 'B', name: 'Business', first: 10_000_000 });

    expect((await call('GET', paths.nextAsn())).json).toEqual({ asn: 3 });
    expect((await call('GET', paths.nextAsn(), undefined, 'series=b')).json).toEqual({
      asn: 10_000_000,
    });
    await add('b one', 10_000_000);
    expect((await call('GET', paths.nextAsn(), undefined, 'series=B')).json).toEqual({
      asn: 10_000_001,
    });
    // The main series is not pushed past the other series' numbers.
    expect((await call('GET', paths.nextAsn())).json).toEqual({ asn: 3 });
    expect((await call('GET', paths.nextAsn(), undefined, 'series=Z')).status).toBe(404);
  });

  it('refuses a prefix twice, and removing a series documents have numbers in', async () => {
    const { call, add } = await server();
    await call('POST', paths.asnSeries(), { prefix: 'H', name: 'Home' });
    expect((await call('POST', paths.asnSeries(), { prefix: 'h', name: 'Again' })).status).toBe(
      409,
    );
    expect((await call('POST', paths.asnSeries(), { prefix: '9x', name: 'Bad' })).status).toBe(400);
    await add('h', 10_000_003);
    expect((await call('DELETE', paths.asnSeriesOne('H'))).status).toBe(409);
    await call('POST', paths.asnSeries(), { prefix: 'E', name: 'Empty' });
    expect((await call('DELETE', paths.asnSeriesOne('E'))).status).toBe(204);
    expect((await call('DELETE', `${paths.asnSeries()}/%E0%A4%A`)).status).toBe(400);
    expect((await call('GET', paths.asnSeries())).json).toEqual({
      series: [{ prefix: 'H', name: 'Home', first: 10_000_000 }],
    });
  });

  it('skips a block a document already has a number in', async () => {
    const { call, add } = await server();
    await add('big', 12_345_678);
    const created = await call('POST', paths.asnSeries(), { prefix: 'W', name: 'Work' });
    expect(created.json['first']).toBe(20_000_000);
  });
});

suite('serial number labels', () => {
  const series: AsnSeries[] = [{ prefix: 'B', name: 'Business', first: 10_000_000 }];

  it('writes a number in a series with its prefix, and reads it back', () => {
    expect(asnLabel(42, series)).toBe('42');
    expect(asnLabel(10_000_041, series)).toBe('B-42');
    expect(asnFromLabel('B-42', series)).toBe(10_000_041);
    expect(asnFromLabel('b 0042', series)).toBe(10_000_041);
    expect(asnFromLabel('42', series)).toBe(42);
    expect(asnFromLabel('Q-42', series)).toBeNull();
    expect(asnFromLabel('B-10000001', series)).toBeNull();
  });
});
