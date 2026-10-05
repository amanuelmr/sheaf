import { useEffect, useMemo, useState } from 'react';
import { api as makeApi, type Api } from './api';
import {
  clearConnection,
  loadConnection,
  rememberedUrl,
  saveConnection,
  type Connection,
} from './connection';
import { Devices } from './pages/Devices';
import { Document } from './pages/Document';
import { Inbox } from './pages/Inbox';
import { Search } from './pages/Search';
import { System } from './pages/System';
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
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const connection: Connection = {
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      token: token.trim(),
    };
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
        <label htmlFor="token">Admin token (SHEAF_TOKEN)</label>
        <input
          id="token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
        {error === null ? null : <p className="error">{error}</p>}
        <button type="submit">Connect</button>
        <p className="muted small">The token is forgotten when you close this tab.</p>
      </form>
    </div>
  );
}

const NAV: readonly { route: Route; label: string }[] = [
  { route: { page: 'search' }, label: 'Search' },
  { route: { page: 'inbox' }, label: 'To review' },
  { route: { page: 'devices' }, label: 'Phones' },
  { route: { page: 'system' }, label: 'System' },
];

function Shell({ connection, onDisconnect }: { connection: Connection; onDisconnect: () => void }) {
  const api = useMemo(() => makeApi(connection), [connection]);
  const route = useRoute();
  const toReview = useInboxCount(api, route);

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href={href({ page: 'search' })}>
          Sheaf
        </a>
        <nav>
          {NAV.map(({ route: target, label }) => (
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
          ))}
        </nav>
        <button className="link" onClick={onDisconnect}>
          Disconnect
        </button>
      </header>
      <main>
        {route.page === 'search' ? <Search api={api} /> : null}
        {route.page === 'document' ? <Document api={api} sha256={route.sha256} /> : null}
        {route.page === 'inbox' ? <Inbox api={api} /> : null}
        {route.page === 'devices' ? <Devices api={api} serverUrl={connection.baseUrl} /> : null}
        {route.page === 'system' ? <System api={api} /> : null}
      </main>
    </div>
  );
}

/** How many documents await review, refreshed whenever the page changes. */
function useInboxCount(api: Api, route: Route): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    void api.inbox().then((result) => {
      if (result.ok) setCount(result.value.documents.length);
    });
  }, [api, route]);
  return count;
}
