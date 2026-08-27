/**
 * Forwarding is the step that makes a stored document findable. It is also the
 * step most likely to fail for a while — the downstream system restarts, the token
 * rotates, the disk fills — so the properties that matter are about what it does
 * *not* do: give up too early, retry a refusal for ever, or let a hand-off problem
 * put the document itself at risk.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { MAX_AUTO_ATTEMPTS } from '@sheaf/core';
import type { ServerOutcome } from '@sheaf/core';
import { err, ok, type ApiResult } from '@sheaf/http';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Forwarder, type ForwardTarget } from '../src/forwarder';
import { Storage, sha256Hex } from '../src/storage';

const A = new Uint8Array(Buffer.from('%PDF-1.4\nforward me\n%%EOF\n'));
const hashA = sha256Hex(A);

interface Fake {
  target: ForwardTarget;
  calls: string[];
  sendResult: ApiResult<string>;
  pollResult: ApiResult<ServerOutcome | 'pending' | null>;
}

function fakeTarget(): Fake {
  const state: Fake = {
    calls: [],
    sendResult: ok('task-1'),
    pollResult: ok('pending'),
    target: {
      send: () => {
        state.calls.push('send');
        return Promise.resolve(state.sendResult);
      },
      poll: () => {
        state.calls.push('poll');
        return Promise.resolve(state.pollResult);
      },
    },
  };
  return state;
}

let storage: Storage;
let fake: Fake;
let clock: number;
let forwarder: Forwarder;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-fwd-')),
  });
  await storage.put(hashA, A, clock, 1);
  fake = fakeTarget();
  forwarder = new Forwarder(storage, fake.target, { now: () => clock, jitter: () => 0 });
});

const forwardOf = async () => (await storage.record(hashA))!.forward;

suite('the happy path', () => {
  it('sends, then completes once the target confirms', async () => {
    expect((await forwardOf()).state).toBe('pending');

    await forwarder.tick();
    expect((await forwardOf()).state).toBe('sent');

    fake.pollResult = ok({ kind: 'stored', remoteId: 4821 });
    await forwarder.tick();

    const forward = await forwardOf();
    expect(forward.state).toBe('done');
    expect(forward.remoteId).toBe('4821');
  });

  it('treats a duplicate as done, because the target already holds it', async () => {
    await forwarder.tick();
    fake.pollResult = ok({ kind: 'duplicate', remoteId: 99 });
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('done');
    expect((await forwardOf()).remoteId).toBe('99');
  });

  it('waits quietly while the target is still working', async () => {
    await forwarder.tick();
    for (let i = 0; i < 5; i++) await forwarder.tick();
    expect((await forwardOf()).state).toBe('sent');
    // Polling, not re-uploading: the bytes are already over there.
    expect(fake.calls.filter((c) => c === 'send')).toHaveLength(1);
  });

  it('stops looking at a document once it is done', async () => {
    await forwarder.tick();
    fake.pollResult = ok({ kind: 'stored', remoteId: 1 });
    await forwarder.tick();

    fake.calls = [];
    const result = await forwarder.tick();
    expect(result.examined).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

suite('when the target is having a bad day', () => {
  it('backs off rather than hammering', async () => {
    fake.sendResult = err({ kind: 'unreachable' });
    await forwarder.tick();

    // 'sent' rather than 'pending': a send whose reply never arrived is
    // indistinguishable from one that never left, so the state records what we
    // actually know -- that the outcome is unresolved -- and the next pass asks the
    // target rather than assuming it can send again.
    const forward = await forwardOf();
    expect(forward.state).toBe('sent');
    expect(forward.attempts).toBe(1);

    // Not due yet, so it is not even looked at.
    fake.calls = [];
    expect((await forwarder.tick()).examined).toBe(0);

    clock += 60_000;
    expect((await forwarder.tick()).examined).toBe(1);
  });

  it('keeps trying an unreachable target rather than giving up on it', async () => {
    // The phone stops after a budget because stopping means asking the user. Here
    // there is no user in the loop and the document is already safe, so a target
    // that is down stays worth retrying -- with the reason recorded throughout.
    fake.sendResult = err({ kind: 'unreachable' });
    for (let i = 0; i < MAX_AUTO_ATTEMPTS * 3; i++) {
      clock += 10 * 60_000;
      await forwarder.tick();
    }
    const forward = await forwardOf();
    expect(forward.state).not.toBe('failed');
    expect(forward.error).toBe('unreachable');
    expect(forward.attempts).toBeGreaterThan(MAX_AUTO_ATTEMPTS);

    // And it succeeds the moment the target comes back. Three passes, because this
    // fake cannot be asked what it has in flight: one to establish that the
    // unresolved attempt is not recoverable, one to send, one to read the outcome.
    fake.sendResult = ok('task-9');
    fake.pollResult = ok({ kind: 'stored', remoteId: 77 });
    clock += 10 * 60_000;
    await forwarder.tick();
    await forwarder.tick();
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('done');
  });

  it('does not retry a refusal that retrying cannot change', async () => {
    fake.sendResult = err({ kind: 'auth', status: 401 });
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('failed');

    clock += 10 * 60_000;
    fake.calls = [];
    expect((await forwarder.tick()).examined).toBe(0);
  });

  it('starts over when the target has forgotten the task', async () => {
    await forwarder.tick();
    fake.pollResult = ok(null);
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('pending');

    // Re-sending is free: the target refuses content it already holds.
    fake.pollResult = ok({ kind: 'duplicate', remoteId: 7 });
    await forwarder.tick();
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('done');
  });

  it('stops on a refusal of the document itself', async () => {
    await forwarder.tick();
    fake.pollResult = ok({ kind: 'consumer_failed', message: 'unsupported file type' });
    await forwarder.tick();
    expect((await forwardOf()).state).toBe('failed');
    expect((await forwardOf()).error).toBe('unsupported file type');
  });
});

suite('forwarding never endangers the document', () => {
  it('leaves the stored bytes alone whatever happens', async () => {
    fake.sendResult = err({ kind: 'auth', status: 401 });
    for (let i = 0; i < 10; i++) {
      clock += 60_000;
      await forwarder.tick();
    }
    // Failed to forward, still ours, still byte-identical.
    expect((await forwardOf()).state).toBe('failed');
    expect(storage.bytes(hashA)).toEqual(A);
    expect(await storage.count()).toBe(1);
  });

  it('reports what it is holding and how far along it is', async () => {
    expect(await storage.forwardCounts()).toEqual({ pending: 1 });
    await forwarder.tick();
    expect(await storage.forwardCounts()).toEqual({ sent: 1 });
  });
});

suite('not trusting the target to deduplicate', () => {
  /**
   * The original design assumed the target would refuse content it already held.
   * A real Paperless-ngx does not — re-sending produced a second document. Since
   * the target can be *asked* by content hash, asking is both cheaper and correct.
   */
  it('asks before sending, and does not send what is already there', async () => {
    const located: ForwardTarget = {
      ...fake.target,
      locate: () => {
        fake.calls.push('locate');
        return Promise.resolve(ok('4821'));
      },
    };
    const f = new Forwarder(storage, located, { now: () => clock, jitter: () => 0 });

    await f.tick();

    expect(fake.calls).toEqual(['locate']);
    expect(fake.calls).not.toContain('send');
    const forward = await forwardOf();
    expect(forward.state).toBe('done');
    expect(forward.remoteId).toBe('4821');
  });

  it('sends when the target genuinely does not have it', async () => {
    const located: ForwardTarget = {
      ...fake.target,
      locate: () => {
        fake.calls.push('locate');
        return Promise.resolve(ok(null));
      },
    };
    const f = new Forwarder(storage, located, { now: () => clock, jitter: () => 0 });
    await f.tick();
    expect(fake.calls).toEqual(['locate', 'send']);
    expect((await forwardOf()).state).toBe('sent');
  });
});
