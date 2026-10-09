import { describe as suite, expect, it } from 'vitest';
import type { FetchLike, HttpResponse } from '@sheaf/http';
import { pairDevice } from '../src/client';

const respond = (status: number, body: unknown): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  text: () => Promise.resolve(JSON.stringify(body)),
});

suite('pairDevice', () => {
  it('posts the code and name without any token, and returns the new one', async () => {
    let sent: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fetch: FetchLike = (url, init) => {
      sent = { url, headers: init!.headers!, body: init!.body as string };
      return Promise.resolve(respond(200, { deviceId: 'd1', token: 'shf_dev_abc' }));
    };
    const result = await pairDevice('http://192.168.1.20:8787', fetch, {
      code: 'K7QX-ABCD',
      deviceName: 'Phone',
    });
    expect(result).toEqual({ ok: true, value: { deviceId: 'd1', token: 'shf_dev_abc' } });
    expect(sent!.url).toBe('http://192.168.1.20:8787/v1/pair');
    expect(sent!.headers['authorization']).toBeUndefined();
    expect(JSON.parse(sent!.body)).toEqual({ code: 'K7QX-ABCD', deviceName: 'Phone' });
  });

  it('reports a bad code as a refusal, and a dead server as unreachable', async () => {
    const refused = await pairDevice(
      'http://x',
      () => Promise.resolve(respond(400, { error: 'pairing_invalid' })),
      {
        code: 'nope',
        deviceName: 'Phone',
      },
    );
    expect(refused.ok ? null : refused.reason.kind).toBe('rejected');
    const down = await pairDevice('http://x', () => Promise.reject(new Error('ECONNREFUSED')), {
      code: 'c',
      deviceName: 'Phone',
    });
    expect(down).toEqual({ ok: false, reason: { kind: 'unreachable' } });
  });
});
