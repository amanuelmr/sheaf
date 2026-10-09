/**
 * Pairing (ADR 0008): a one-time code becomes a device token, and the token can be
 * taken back. What matters is what cannot happen: a code used twice or late, a
 * secret stored in the clear, a revoked phone still getting in.
 */
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver, type NodeSqliteDriver } from '@sheaf/store/node';
import { Devices, PAIRING_CODE_TTL_MS, normaliseCode } from '../src/devices';
import { migrate } from '../src/migrations';

let driver: NodeSqliteDriver;
let devices: Devices;
let clock: number;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  driver = nodeSqliteDriver();
  // Pairing needs only its own tables, but migrations run in order from the start.
  await driver.exec(
    `CREATE TABLE documents (sha256 TEXT PRIMARY KEY, received_at INTEGER, tags TEXT,
       forward_state TEXT DEFAULT 'pending', forward_attempts INTEGER DEFAULT 0,
       forward_next_at INTEGER, forward_task_id TEXT, remote_id TEXT, forward_error TEXT,
       forward_done_at INTEGER, correspondent TEXT, document_type TEXT)`,
  );
  await migrate(driver, clock);
  devices = new Devices(driver, { now: () => clock });
});

suite('pairing', () => {
  it('turns a fresh code into a working device token', async () => {
    const { code } = await devices.createPairingCode();
    const paired = await devices.pair(code, 'Amanuel’s iPhone');
    expect(paired).not.toBeNull();
    const who = await devices.authenticate(paired!.token);
    expect(who).toEqual({ kind: 'device', id: paired!.deviceId, name: 'Amanuel’s iPhone' });
  });

  it('accepts a code however it was typed', async () => {
    const { code } = await devices.createPairingCode();
    const typed = ` ${code.toLowerCase().replace(/-/g, ' ')} `;
    expect(normaliseCode(typed)).toBe(normaliseCode(code));
    expect(await devices.pair(typed, 'Phone')).not.toBeNull();
  });

  it('accepts a code once only', async () => {
    const { code } = await devices.createPairingCode();
    expect(await devices.pair(code, 'First')).not.toBeNull();
    expect(await devices.pair(code, 'Second')).toBeNull();
  });

  it('refuses a code after five minutes', async () => {
    const { code } = await devices.createPairingCode();
    clock += PAIRING_CODE_TTL_MS;
    expect(await devices.pair(code, 'Late')).toBeNull();
  });

  it('refuses a code it never issued', async () => {
    expect(await devices.pair('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GG', 'Guess')).toBeNull();
  });

  it('never stores a code or a token in the clear', async () => {
    const { code } = await devices.createPairingCode();
    const paired = await devices.pair(code, 'Phone');
    const everything = JSON.stringify([
      await driver.all('SELECT * FROM pairing_codes'),
      await driver.all('SELECT * FROM devices'),
    ]);
    expect(everything).not.toContain(normaliseCode(code));
    expect(everything).not.toContain(paired!.token);
  });
});

suite('devices', () => {
  it('tells a revoked device it was revoked, rather than that its token is wrong', async () => {
    const { code } = await devices.createPairingCode();
    const paired = (await devices.pair(code, 'Lost phone'))!;
    expect(await devices.revoke(paired.deviceId)).toBe(true);
    expect(await devices.authenticate(paired.token)).toEqual({ kind: 'revoked' });
    expect(await devices.authenticate('shf_dev_not-a-real-token')).toBeNull();
  });

  it('lists devices with when each was last seen, updated at most once a minute', async () => {
    const { code } = await devices.createPairingCode();
    const paired = (await devices.pair(code, 'Phone'))!;
    await devices.authenticate(paired.token);
    clock += 10_000;
    await devices.authenticate(paired.token);
    expect((await devices.list())[0]!.lastSeen).toBe(1_700_000_000_000);
    clock += 60_000;
    await devices.authenticate(paired.token);
    expect((await devices.list())[0]).toMatchObject({
      name: 'Phone',
      lastSeen: 1_700_000_070_000,
      revoked: false,
    });
  });

  it('revoking twice, or something unknown, is harmless', async () => {
    const { code } = await devices.createPairingCode();
    const paired = (await devices.pair(code, 'Phone'))!;
    expect(await devices.revoke(paired.deviceId)).toBe(true);
    expect(await devices.revoke(paired.deviceId)).toBe(true);
    expect(await devices.revoke('nonexistent')).toBe(false);
  });

  it('keeps device names reasonable', async () => {
    const { code } = await devices.createPairingCode();
    const paired = (await devices.pair(code, `  ${'x'.repeat(200)}  `))!;
    expect((await devices.list())[0]!.name).toHaveLength(64);
    expect(paired.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
