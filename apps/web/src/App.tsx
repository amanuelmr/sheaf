import { useEffect, useMemo, useState } from 'react';
import { api as makeApi, signIn, type Api } from './api';
import type { Role } from '@sheaf/protocol';
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

export default function App() {
  const [connection, setConnection] = useState<Connection | null>(() => loadConnection());
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
        setError(`Couldn’t sign in: ${signed.message}`);
        return;
      }
      secret = signed.value.token;
    }
    const connection: Connection = { baseUrl: server, token: secret };
    if (connection.baseUrl === '' || connection.token === '') return;
    // Check before keeping it, so a typo is caught here rather than on every page.
    const health = await makeApi(connection).health();
    if (!health.ok) {
      setError(`Couldn’t connect: ${health.message}`);
      return;
    }
    saveConnection(connection);
    onConnect(connection);
  };

  return (
    <div className="page narrow">
      <h1>Sheaf</h1>
      <p className="subtitle">
        Your documents, on your server. Connect with the admin token it was started with.
      </p>
      <form className="card" onSubmit={(event) => void submit(event)}>
        <label htmlFor="baseUrl">Server address</label>
        <input
          id="baseUrl"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.20:8787"
          autoComplete="url"
        />
        <div className="tabs" role="group" aria-label="How to connect">
          <button
            type="button"
            className="secondary"
            aria-pressed={!useAccount}
            onClick={() => setUseAccount(false)}
          >
            Admin token
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={useAccount}
            onClick={() => setUseAccount(true)}
          >
            Username and password
          </button>
        </div>
        {useAccount ? (
          <>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
            <label htmlFor="password">Password</label>
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
            <label htmlFor="token">Admin token (SHEAF_TOKEN)</label>
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
        <button type="submit">Connect</button>
        <p className="muted small">The token is forgotten when you close this tab.</p>
      </form>
    </div>
  );
}

/** Pages only an admin can use; a phone or a non-admin person does not see them. */
const ADMIN_PAGES: ReadonlySet<Route['page']> = new Set(['devices', 'workflows', 'users']);

const NAV: readonly { route: Route; label: string }[] = [
  { route: { page: 'search' }, label: 'Search' },
  { route: { page: 'inbox' }, label: 'To review' },
  { route: { page: 'devices' }, label: 'Phones' },
  { route: { page: 'labels' }, label: 'Labels' },
  { route: { page: 'fields' }, label: 'Fields' },
  { route: { page: 'workflows' }, label: 'Workflows' },
  { route: { page: 'trash' }, label: 'Trash' },
  { route: { page: 'users' }, label: 'Users' },
  { route: { page: 'system' }, label: 'System' },
];

function Shell({ connection, onDisconnect }: { connection: Connection; onDisconnect: () => void }) {
  const api = useMemo(() => makeApi(connection), [connection]);
  const route = useRoute();
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
                {label}
                {target.page === 'inbox' && toReview > 0 ? (
                  <span className="count">{toReview}</span>
                ) : null}
              </a>
            ),
          )}
        </nav>
        <button className="link" onClick={() => void signOut()}>
          {who === null ? 'Disconnect' : `Sign out ${who}`}
        </button>
      </header>
      <main>
        {role !== null && role !== 'admin' && ADMIN_PAGES.has(route.page) ? (
          <p className="muted">
            This page is for admins. <a href={href({ page: 'search' })}>Go to search</a>.
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
        {route.page === 'inbox' ? <Inbox api={api} /> : null}
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
