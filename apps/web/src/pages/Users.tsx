import { useCallback, useEffect, useState } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  ROLES,
  USERNAME_PATTERN,
  type Role,
  type User,
} from '@sheaf/protocol';
import type { Api, Result } from '../api';
import { when } from '../format';
import { mark, t } from '../i18n';
import { Status, type Problem } from '../status';

// English: each is put through `t` where it is drawn.
const ROLE_NAMES: Readonly<Record<Role, string>> = {
  admin: mark('Admin: everything'),
  editor: mark('Editor: read and change documents'),
  viewer: mark('Viewer: read only'),
};

const ROLE_SHORT: Readonly<Record<Role, string>> = {
  admin: mark('admin'),
  editor: mark('editor'),
  viewer: mark('viewer'),
};

/** People who sign in, and what each may do. */
export function Users({ api }: { api: Api }) {
  const [users, setUsers] = useState<readonly User[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [resetting, setResetting] = useState<{ id: number; password: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api.users();
    if (result.ok) setUsers(result.value.users);
    else setError(result);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (change: Promise<Result<unknown>>) => {
    const result = await change;
    if (!result.ok) {
      setError(result);
      return false;
    }
    setError(null);
    await load();
    return true;
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = username.trim().toLowerCase();
    if (await run(api.createUser({ username: name, password, role }))) {
      setUsername('');
      setPassword('');
    }
  };

  const nameOk = USERNAME_PATTERN.test(username.trim().toLowerCase());
  const passwordOk = password.length >= MIN_PASSWORD_LENGTH;

  return (
    <div>
      <h1>{t('Users')}</h1>
      <p className="subtitle">
        {t(
          'People who sign in with a username and password. The admin token and paired phones keep working alongside them.',
        )}
      </p>
      <Status error={error} />
      {users === null ? <p className="muted">{t('Loading…')}</p> : null}
      {users !== null && users.length === 0 ? <p className="muted">{t('No users yet.')}</p> : null}
      <ul className="list">
        {(users ?? []).map((user) => (
          <li key={user.id}>
            <div>
              <strong>
                {user.username}
                {user.disabledAt === null ? null : (
                  <span className="badge neutral">{t('disabled')}</span>
                )}
              </strong>
              <span className="muted">
                {user.lastSignIn === null
                  ? t('Never signed in')
                  : t('Last signed in {when}', { when: when(user.lastSignIn) })}
              </span>
            </div>
            <div className="actions">
              <select
                aria-label={t('Role of {name}', { name: user.username })}
                value={user.role}
                onChange={(event) =>
                  void run(api.updateUser(user.id, { role: event.target.value as Role }))
                }
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_SHORT[r])}
                  </option>
                ))}
              </select>
              {resetting?.id === user.id ? (
                <form
                  className="asn-input"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(api.updateUser(user.id, { password: resetting.password })).then(
                      (ok) => {
                        if (ok) setResetting(null);
                      },
                    );
                  }}
                >
                  <input
                    type="password"
                    aria-label={t('New password for {name}', { name: user.username })}
                    autoComplete="new-password"
                    value={resetting.password}
                    onChange={(event) =>
                      setResetting({ id: user.id, password: event.target.value })
                    }
                  />
                  <button type="submit" disabled={resetting.password.length < MIN_PASSWORD_LENGTH}>
                    {t('Set')}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setResetting({ id: user.id, password: '' })}
                >
                  {t('New password')}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void run(api.updateUser(user.id, { disabled: user.disabledAt === null }))
                }
              >
                {user.disabledAt === null ? t('Disable') : t('Enable')}
              </button>
              <button
                type="button"
                className="link"
                onClick={() => void run(api.deleteUser(user.id))}
              >
                {t('Remove')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>{t('New user')}</h2>
      <form className="card" onSubmit={(event) => void create(event)}>
        <label htmlFor="user-name">{t('Username')}</label>
        <input
          id="user-name"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        {username === '' || nameOk ? null : (
          <p className="muted small">
            {t('Lower case letters, digits, dots, dashes and underscores; 2 to 32 of them.')}
          </p>
        )}
        <label htmlFor="user-password">{t('Password')}</label>
        <input
          id="user-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {password === '' || passwordOk ? null : (
          <p className="muted small">
            {t('At least {count} characters.', { count: MIN_PASSWORD_LENGTH })}
          </p>
        )}
        <label htmlFor="user-role">{t('Role')}</label>
        <select
          id="user-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(ROLE_NAMES[r])}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!nameOk || !passwordOk}>
          {t('Add user')}
        </button>
      </form>
    </div>
  );
}
