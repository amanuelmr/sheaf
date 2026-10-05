import { describe as suite, expect, it } from 'vitest';
import { archiveFromEnv, extractionFromEnv, retentionFromEnv } from '../src/config';
import type { FetchLike } from '@sheaf/http';

const DAY = 24 * 60 * 60 * 1000;

suite('retentionFromEnv', () => {
  it('is off unless days are set', () => {
    expect(retentionFromEnv({}, ['paperless'])).toEqual({ kind: 'off' });
    expect(retentionFromEnv({ SHEAF_RETENTION_DAYS: '' }, ['paperless'])).toEqual({
      kind: 'off',
    });
  });

  it('is on with days and a configured connector', () => {
    expect(
      retentionFromEnv({ SHEAF_RETENTION_DAYS: '30', SHEAF_RETENTION_CONNECTOR: 'paperless' }, [
        'paperless',
      ]),
    ).toEqual({ kind: 'on', config: { ms: 30 * DAY, connector: 'paperless' } });
  });

  it('refuses days without a named connector, rather than guessing which copy to trust', () => {
    const setting = retentionFromEnv({ SHEAF_RETENTION_DAYS: '30' }, ['paperless']);
    expect(setting.kind).toBe('invalid');
  });

  it('refuses a connector that is not configured', () => {
    const setting = retentionFromEnv(
      { SHEAF_RETENTION_DAYS: '30', SHEAF_RETENTION_CONNECTOR: 'paperless' },
      [],
    );
    expect(setting.kind === 'invalid' && setting.message).toMatch(/configured: none/);
  });

  it.each(['0', '-3', 'thirty', 'Infinity'])('refuses %s days', (days) => {
    const setting = retentionFromEnv(
      { SHEAF_RETENTION_DAYS: days, SHEAF_RETENTION_CONNECTOR: 'paperless' },
      ['paperless'],
    );
    expect(setting.kind).toBe('invalid');
  });
});

suite('archiveFromEnv', () => {
  it("browses the server's own catalog unless told otherwise", () => {
    expect(archiveFromEnv({}, true)).toEqual({ kind: 'native' });
    expect(archiveFromEnv({ SHEAF_ARCHIVE_SOURCE: 'native' }, false)).toEqual({ kind: 'native' });
  });

  it('browses Paperless when asked and configured', () => {
    expect(archiveFromEnv({ SHEAF_ARCHIVE_SOURCE: 'paperless' }, true)).toEqual({
      kind: 'paperless',
    });
  });

  it('refuses Paperless without Paperless, and anything unknown', () => {
    expect(archiveFromEnv({ SHEAF_ARCHIVE_SOURCE: 'paperless' }, false).kind).toBe('invalid');
    expect(archiveFromEnv({ SHEAF_ARCHIVE_SOURCE: 'dropbox' }, true).kind).toBe('invalid');
  });
});

suite('extractionFromEnv', () => {
  const fetch: FetchLike = () => Promise.reject(new Error('no network in this test'));
  const choose = (env: Record<string, string>, paperless = false) =>
    extractionFromEnv(env, paperless, fetch);

  it('reads documents on this server, sending nothing anywhere, unless told otherwise', () => {
    const choice = choose({});
    expect(choice.kind === 'native' && [choice.extractor.name, choice.sendsTextAway]).toEqual([
      'heuristic',
      false,
    ]);
    expect(choice.kind === 'native' && [choice.dateOrder, choice.defaultCurrency]).toEqual([
      'DMY',
      'EUR',
    ]);
  });

  it('uses Claude only with a key, and says that text leaves the server', () => {
    expect(choose({ SHEAF_EXTRACTOR: 'claude' }).kind).toBe('invalid');
    const choice = choose({ SHEAF_EXTRACTOR: 'claude', ANTHROPIC_API_KEY: 'sk-x' });
    expect(choice.kind === 'native' && [choice.extractor.name, choice.sendsTextAway]).toEqual([
      'claude',
      true,
    ]);
  });

  it('uses Ollama with a URL and a model, keeping text on the network', () => {
    expect(choose({ SHEAF_EXTRACTOR: 'ollama', SHEAF_OLLAMA_URL: 'http://o:11434' }).kind).toBe(
      'invalid',
    );
    const choice = choose({
      SHEAF_EXTRACTOR: 'ollama',
      SHEAF_OLLAMA_URL: 'http://o:11434',
      SHEAF_OLLAMA_MODEL: 'llama3.2:3b',
    });
    expect(choice.kind === 'native' && choice.sendsTextAway).toBe(false);
  });

  it('falls back to Paperless suggestions only where Paperless is configured', () => {
    expect(choose({ SHEAF_EXTRACTOR: 'paperless' }, true).kind).toBe('paperless');
    expect(choose({ SHEAF_EXTRACTOR: 'paperless' }, false).kind).toBe('invalid');
  });

  it.each([{ SHEAF_EXTRACTOR: 'gpt' }, { SHEAF_DATE_ORDER: 'DDMM' }, { SHEAF_CURRENCY: 'euro' }])(
    'refuses %j',
    (env) => {
      expect(choose(env).kind).toBe('invalid');
    },
  );
});
