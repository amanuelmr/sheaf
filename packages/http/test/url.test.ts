import { describe as suite, expect, it } from 'vitest';
import { joinUrl } from '../src/url';

suite('joinUrl', () => {
  it('does not care how the user typed their server URL', () => {
    for (const base of [
      'https://p.example.com',
      'https://p.example.com/',
      'https://p.example.com///',
    ]) {
      expect(joinUrl(base, 'api/tasks/')).toBe('https://p.example.com/api/tasks/');
    }
  });

  it('preserves a path prefix, for servers behind a reverse proxy subpath', () => {
    expect(joinUrl('https://home.example.com/paperless/', '/api/tags/')).toBe(
      'https://home.example.com/paperless/api/tags/',
    );
  });
});
