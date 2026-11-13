/** Single sign-on lands only for the sign-in this tab started, on the server it chose. */
import { describe as suite, expect, it } from 'vitest';
import { finishSingleSignOn, startSingleSignOn, type Store } from '../src/sso';
import { pdfUrl } from '../src/api';

function store(): Store & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const SERVER = 'https://sheaf.example';

/** The fragment the server puts on its way back, with this sign-in's value. */
function landing(start: string, extra: Record<string, string> = {}): string {
  const client = new URL(start).searchParams.get('client')!;
  return `#${new URLSearchParams({ sso: 'session-token', client, ...extra }).toString()}`;
}

suite('single sign-on in the web app', () => {
  it('sends a fresh value of the length the server takes along with the sign-in', () => {
    const one = new URL(startSingleSignOn(SERVER, store()));
    const two = new URL(startSingleSignOn(SERVER, store()));
    expect(one.origin + one.pathname).toBe(`${SERVER}/v1/sso/start`);
    expect(one.searchParams.get('client')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(one.searchParams.get('client')).not.toBe(two.searchParams.get('client'));
  });

  it('keeps the session for the server chosen before leaving, not one the fragment names', () => {
    const tab = store();
    const start = startSingleSignOn(SERVER, tab);
    expect(finishSingleSignOn(landing(start, { server: 'https://evil.example' }), tab)).toEqual({
      baseUrl: SERVER,
      token: 'session-token',
    });
  });

  it('refuses a landing this tab never started', () => {
    const fragment = '#sso=attacker-session&server=https%3A%2F%2Fevil.example&client=x';
    expect(finishSingleSignOn(fragment, store())).toBeNull();
  });

  it('refuses a landing carrying another sign-in’s value', () => {
    const tab = store();
    startSingleSignOn(SERVER, tab);
    const theirs = startSingleSignOn(SERVER, store());
    expect(finishSingleSignOn(landing(theirs), tab)).toBeNull();
  });

  it('lets a sign-in land only once', () => {
    const tab = store();
    const start = startSingleSignOn(SERVER, tab);
    expect(finishSingleSignOn(landing(start), tab)).not.toBeNull();
    expect(finishSingleSignOn(landing(start), tab)).toBeNull();
    expect(tab.items.size).toBe(0);
  });
});

suite('showing a document', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer;

  it('shows a PDF as a PDF', () => {
    const result = pdfUrl(bytes('%PDF-1.7\n...'));
    expect(result.ok).toBe(true);
  });

  it('refuses anything else, so a page from a wrong server never runs', () => {
    expect(pdfUrl(bytes('<script>steal()</script>')).ok).toBe(false);
    expect(pdfUrl(bytes('')).ok).toBe(false);
  });
});
