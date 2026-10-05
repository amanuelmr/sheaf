import { describe as suite, expect, it } from 'vitest';
import { retentionFromEnv } from '../src/config';

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
