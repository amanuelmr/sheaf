/** The built web app runs only its own scripts. */
import { describe as suite, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/content-security-policy';

const directives = new Map(
  CONTENT_SECURITY_POLICY.split('; ').map((d) => {
    const [name, ...values] = d.split(' ');
    return [name, values] as const;
  }),
);

suite('the content security policy', () => {
  it('lets no script run but the app’s own, and no page take over its links or forms', () => {
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('frames only the PDFs the app made itself', () => {
    expect(directives.get('frame-src')).toEqual(['blob:']);
  });
});
