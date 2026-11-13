/** Messages land in regions a screen reader is already watching. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe as suite, expect, it } from 'vitest';
import { failureFor } from '../src/errors';
import { Status } from '../src/status';

const html = (props: Parameters<typeof Status>[0]) =>
  renderToStaticMarkup(createElement(Status, props));

suite('the status area', () => {
  it('is in the page before there is anything to say', () => {
    expect(html({})).toBe(
      '<span class="status block" role="alert"></span><span class="status block" role="status"></span>',
    );
  });

  it('puts a failure in the alert, with the server’s words behind technical details', () => {
    const out = html({ error: failureFor(400, { error: 'bad_request', detail: 'name is empty' }) });
    expect(out).toContain(
      'role="alert"><span class="error">The server didn’t accept that: name is empty',
    );
    expect(out).toContain(
      '<summary>Technical details</summary><code>bad_request: name is empty</code>',
    );
  });

  it('says a success politely, and a plain sentence without details', () => {
    expect(html({ notice: { ok: true, text: 'Saved' }, inline: true })).toContain(
      'role="status"><span class="badge ok">Saved</span>',
    );
    expect(html({ error: 'Pick a name' })).not.toContain('<details');
  });
});
