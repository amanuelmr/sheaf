import { useEffect, useMemo, useState } from 'react';
import { api as makeApi, signIn, type Api } from './api';
import { paths, type Role, type SsoResponse } from '@sheaf/protocol';
import {
  clearConnection,
  loadConnection,
  rememberedUrl,
  saveConnection,
  type Connection,
} from './connection';
import { Devices } from './pages/Devices';
import { Fields } from './pages/Fields';
import { Document } from './pages/Document';
import { INBOX_CHANGED, Inbox } from './pages/Inbox';
import { Labels } from './pages/Labels';
import { Workflows } from './pages/Workflows';
import { Users } from './pages/Users';
import { Search } from './pages/Search';
import { System } from './pages/System';
import { Trash } from './pages/Trash';
import { href, useRoute, type Route } from './route';
import { finishSingleSignOn, startSingleSignOn } from './sso';
import { LANGUAGES, mark, setLanguage, t, useLanguage, type Language } from './i18n';

/**
 * Back from single sign-on: keep the session like any connection, and take the
 * fragment out of the address bar and the history at once, even when refused.
 */
function fromSingleSignOn(): Connection | null {
  if (!/(^#|&)sso=/.test(window.location.hash)) return null;
  let connection: Connection | null = null;
  try {
    connection = finishSingleSignOn(window.location.hash, sessionStorage);
  } catch {
    // Storage refused: no sign-in this tab started can be told apart, so none is.
  }
  if (connection !== null) saveConnection(connection);
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}#/search`,
  );
  return connection;
}

export default function App() {
  const [connection, setConnection] = useState<Connection | null>(
    () => fromSingleSignOn() ?? loadConnection(),
  );
  if (connection === null) return <ConnectScreen onConnect={setConnection} />;
  return (
    <Shell
      connection={connection}
      onDisconnect={() => {
        clearConnection();
        setConnection(null);
      }}
    />
  );
}

function ConnectScreen({ onConnect }: { onConnect: (connection: Connection) => void }) {
  const [baseUrl, setBaseUrl] = useState(rememberedUrl);
  const [token, setToken] = useState('');
  const [useAccount, setUseAccount] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const server = baseUrl.trim().replace(/\/+$/, '');
    let secret = token.trim();
    if (useAccount) {
      if (server === '' || username.trim() === '' || password === '') return;
      const signed = await signIn(server, username.trim().toLowerCase(), password);
      if (!signed.ok) {
        setError(signed.message);
        return;
      }
      secret = signed.value.token;
    }
    const connection: Connection = { baseUrl: server, token: secret };
    if (connection.baseUrl === '' || connection.token === '') return;
    // Check before keeping it, so a typo is caught here rather than on every page.
    const health = await makeApi(connection).health();
    if (!health.ok) {
      setError(health.message);
      return;
    }
    saveConnection(connection);
    onConnect(connection);
  };

  useLanguage();
  return (
    <div className="page narrow">
      <h1>Sheaf</h1>
      <p className="subtitle">
        {t('Your documents, on your server. Connect with the admin token it was started with.')}
      </p>
      <LanguagePicker />
      <form className="card" onSubmit={(event) => void submit(event)}>
        <label htmlFor="baseUrl">{t('Server address')}</label>
        <input
          id="baseUrl"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.20:8787"
          autoComplete="url"
        />
        <div className="tabs" role="group" aria-label={t('How to connect')}>
          <button
            type="button"
            className="secondary"
            aria-pressed={!useAccount}
            onClick={() => setUseAccount(false)}
          >
            {t('Admin token')}
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={useAccount}
            onClick={() => setUseAccount(true)}
          >
            {t('Username and password')}
          </button>
        </div>
        {useAccount ? (
          <>
            <label htmlFor="username">{t('Username')}</label>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
            <label htmlFor="password">{t('Password')}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </>
        ) : (
          <>
            <label htmlFor="token">{t('Admin token')} (SHEAF_TOKEN)</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
            />
          </>
        )}
        {error === null ? null : <p className="error">{error}</p>}
        <button type="submit">{t('Connect')}</button>
        <SingleSignOn baseUrl={baseUrl} />
        <p className="muted small">{t('The token is forgotten when you close this tab.')}</p>
      </form>
    </div>
  );
}

/** Pages only an admin can use; a phone or a non-admin person does not see them. */
const ADMIN_PAGES: ReadonlySet<Route['page']> = new Set(['devices', 'workflows', 'users']);

const NAV: readonly { route: Route; label: string }[] = [
  // English: each is put through `t` as the menu is drawn.
  { route: { page: 'search' }, label: mark('Search') },
  { route: { page: 'inbox' }, label: mark('To review') },
  { route: { page: 'devices' }, label: mark('Phones') },
  { route: { page: 'labels' }, label: mark('Labels') },
  { route: { page: 'fields' }, label: mark('Fields') },
  { route: { page: 'workflows' }, label: mark('Workflows') },
  { route: { page: 'trash' }, label: mark('Trash') },
  { route: { page: 'users' }, label: mark('Users') },
  { route: { page: 'system' }, label: mark('System') },
];

function Shell({ connection, onDisconnect }: { connection: Connection; onDisconnect: () => void }) {
  const api = useMemo(() => makeApi(connection), [connection]);
  const route = useRoute();
  // Every page below is drawn again in the new language when it changes.
  useLanguage();
  const toReview = useInboxCount(api, route);
  const [role, setRole] = useState<Role | null>(null);
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    void api.me().then((result) => {
      if (result.ok) {
        setRole(result.value.role);
        setWho(result.value.name);
      }
    });
  }, [api]);
  const signOut = async () => {
    if (who !== null) await api.signOut();
    onDisconnect();
  };

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href={href({ page: 'search' })}>
          Sheaf
        </a>
        <nav>
          {NAV.filter(({ route: target }) => role === 'admin' || !ADMIN_PAGES.has(target.page)).map(
            ({ route: target, label }) => (
              <a
                key={label}
                href={href(target)}
                aria-current={route.page === target.page ? 'page' : undefined}
              >
                {t(label)}
                {target.page === 'inbox' && toReview > 0 ? (
                  <span className="count">{toReview}</span>
                ) : null}
              </a>
            ),
          )}
        </nav>
        <LanguagePicker />
        <button className="link" onClick={() => void signOut()}>
          {who === null ? t('Disconnect') : t('Sign out {name}', { name: who })}
        </button>
      </header>
      <main>
        {role !== null && role !== 'admin' && ADMIN_PAGES.has(route.page) ? (
          <p className="muted">
            {t('This page is for admins.')}{' '}
            <a href={href({ page: 'search' })}>{t('Go to search')}</a>
          </p>
        ) : null}
        {route.page === 'search' ? (
          // Keyed by the address it opened with, so following a link to a filtered
          // search starts from that filter. Typing only rewrites the address in place.
          <Search
            key={href(route)}
            api={api}
            {...(route.filter ? { initial: route.filter } : {})}
          />
        ) : null}
        {route.page === 'document' ? (
          // Keyed, so moving to another document starts with nothing left over from
          // the last one: no drafts, notes or half-confirmed delete.
          <Document key={route.sha256} api={api} sha256={route.sha256} />
        ) : null}
        {route.page === 'inbox' ? (
          <Inbox api={api} canAdd={role !== null && role !== 'viewer'} />
        ) : null}
        {route.page === 'devices' && role === 'admin' ? (
          <Devices api={api} serverUrl={connection.baseUrl} />
        ) : null}
        {route.page === 'trash' ? <Trash api={api} /> : null}
        {route.page === 'labels' ? <Labels api={api} /> : null}
        {route.page === 'fields' ? <Fields api={api} /> : null}
        {route.page === 'workflows' && role === 'admin' ? <Workflows api={api} /> : null}
        {route.page === 'users' && role === 'admin' ? <Users api={api} /> : null}
        {route.page === 'system' ? <System api={api} /> : null}
      </main>
    </div>
  );
}

/** How many documents await review, refreshed whenever the page changes. */
function useInboxCount(api: Api, route: Route): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () =>
      void api.inbox().then((result) => {
        if (result.ok) setCount(result.value.documents.length);
      });
    refresh();
    window.addEventListener(INBOX_CHANGED, refresh);
    return () => window.removeEventListener(INBOX_CHANGED, refresh);
  }, [api, route]);
  return count;
}

/** The language the web app speaks, kept in this browser. */
function LanguagePicker() {
  const current = useLanguage();
  return (
    <select
      className="language"
      aria-label={t('Language')}
      value={current}
      onChange={(event) => setLanguage(event.target.value as Language)}
    >
      {Object.entries(LANGUAGES).map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}

/** "Sign in with …", when the server at the address typed offers single sign-on. */
function SingleSignOn({ baseUrl }: { baseUrl: string }) {
  const [provider, setProvider] = useState<string | null>(null);
  const server = baseUrl.trim().replace(/\/+$/, '');
  useEffect(() => {
    setProvider(null);
    if (!/^https?:\/\/./.test(server)) return;
    let current = true;
    const timer = setTimeout(() => {
      void fetch(new URL(paths.sso(), server).toString())
        .then((response) => (response.ok ? (response.json() as Promise<SsoResponse>) : null))
        .then((sso) => {
          if (current && sso?.enabled === true) setProvider(sso.name ?? t('single sign-on'));
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [server]);
  if (provider === null) return null;
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        try {
          window.location.assign(startSingleSignOn(server, sessionStorage));
        } catch {
          setProvider(null);
        }
      }}
    >
      {t('Sign in with {provider}', { provider })}
    </button>
  );
}
