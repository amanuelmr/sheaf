/** A pairing link is shown for what it is before the phone acts on it. */
import { describe as suite, expect, it } from 'vitest';
import { readPairingLink } from '../src/lib/pairing';

suite('reading a pairing link', () => {
  it('names the server it would connect to, and whether the line is encrypted', () => {
    expect(readPairingLink('https://sheaf.home.example/', 'ABC123')).toEqual({
      ok: true,
      server: 'https://sheaf.home.example',
      code: 'ABC123',
      host: 'sheaf.home.example',
      encrypted: true,
    });
    expect(readPairingLink('http://192.168.1.20:8787', 'x')).toMatchObject({
      host: '192.168.1.20:8787',
      encrypted: false,
    });
  });

  it('keeps a path the server is served under', () => {
    expect(readPairingLink('https://home.example/sheaf/', 'x')).toMatchObject({
      server: 'https://home.example/sheaf',
      host: 'home.example',
    });
  });

  it('refuses an address whose shown name is not where it goes', () => {
    expect(readPairingLink('https://my-nas@evil.example', 'x').ok).toBe(false);
  });

  it('refuses anything but a plain web address with a code', () => {
    expect(readPairingLink('javascript:alert(1)', 'x').ok).toBe(false);
    expect(readPairingLink('https://sheaf.example/?next=elsewhere', 'x').ok).toBe(false);
    expect(readPairingLink('https://sheaf.example', '  ').ok).toBe(false);
    expect(readPairingLink(undefined, 'x').ok).toBe(false);
  });
});
