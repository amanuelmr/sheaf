import { createHash } from 'node:crypto';
import { describe as suite, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256';

const ascii = (s: string): Uint8Array => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));

suite('sha256', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex(ascii(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(ascii('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto at every padding boundary', () => {
    // The padding block is where a hand-written SHA-256 goes wrong: lengths of
    // 55, 56, 63, 64 and 119 bytes each hit a different branch.
    for (let length = 0; length <= 200; length++) {
      const input = new Uint8Array(length);
      for (let i = 0; i < length; i++) input[i] = (i * 37 + 11) & 0xff;
      const expected = createHash('sha256').update(input).digest('hex');
      expect(sha256Hex(input), `length ${length}`).toBe(expected);
    }
  });

  it('agrees with node:crypto on inputs the size of a real scan', () => {
    for (const length of [4_096, 65_536, 1_000_000, 1_048_577]) {
      const input = new Uint8Array(length);
      for (let i = 0; i < length; i++) input[i] = (i * 131 + 7) & 0xff;
      expect(sha256Hex(input), `length ${length}`).toBe(
        createHash('sha256').update(input).digest('hex'),
      );
    }
  });

  it('changes completely when a single bit changes', () => {
    const a = new Uint8Array(64).fill(0x5a);
    const b = new Uint8Array(64).fill(0x5a);
    b[31] = 0x5b;
    const [x, y] = [sha256Hex(a), sha256Hex(b)];
    expect(x).not.toBe(y);
    const shared = [...x].filter((ch, i) => ch === y[i]).length;
    expect(shared).toBeLessThan(20); // 64 hex chars; collision-by-position is noise
  });
});
