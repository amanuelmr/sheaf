/** Messages land in regions a screen reader is already watching. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe as suite, expect, it } from 'vitest';
import { failureFor } from '../src/errors';
import { Regions, Status } from '../src/status';

const html = (props: Parameters<typeof Regions>[0]) =>
  renderToStaticMarkup(createElement(Regions, props));

suite('the status area', () => {
  it('is in the page before there is anything to say', () => {
    expect(html({})).toBe(
      '<span class="status block" role="alert"></span><span class="status block" role="status"></span>',
    );
  });

  it('holds back a message there from the start until the regions are in the page', () => {
    const first = renderToStaticMarkup(createElement(Status, { error: 'Pick a name' }));
    expect(first).toBe(html({}));
  });

  it('puts a failure in the alert, with the server’s words behind technical details', () => {
    const out = html({ error: failureFor(400, { error: 'bad_request', detail: 'name is empty' }) });
    expect(out).toContain(
      'role="alert"><span class="error">The server didn’t accept that: name is empty',
    );
    // Only phrasing content, so it may sit inside a paragraph.
    expect(out).toContain('aria-expanded="false">Technical details</button>');
    expect(out).not.toMatch(/<(details|div|p)\b/);
  });

  it('says a success politely, and a plain sentence without details', () => {
    expect(html({ notice: { ok: true, text: 'Saved' }, inline: true })).toContain(
      'role="status"><span class="badge ok">Saved</span>',
    );
    expect(html({ error: 'Pick a name' })).not.toContain('Technical details');
  });
});
