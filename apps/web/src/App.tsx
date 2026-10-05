import { useEffect, useState } from 'react';
import type { HealthResponse } from '@sheaf/protocol';
import { fetchHealth } from './api';
import { clearConnection, loadConnection, saveConnection, type Connection } from './connection';

const POLL_MS = 5_000;

export default function App() {
  const [connection, setConnection] = useState<Connection | null>(() => loadConnection());

  if (connection === null) {
    return <ConnectScreen onConnect={setConnection} />;
  }
  return (
    <Dashboard
      connection={connection}
      onDisconnect={() => {
        clearConnection();
        setConnection(null);
      }}
    />
  );
}

function ConnectScreen({ onConnect }: { onConnect: (connection: Connection) => void }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (baseUrl.trim() === '' || token.trim() === '') return;
    const connection: Connection = { baseUrl: baseUrl.trim(), token: token.trim() };
    saveConnection(connection);
    onConnect(connection);
  };

  return (
    <div className="page">
      <h1>Sheaf admin</h1>
      <p className="subtitle">
        A window onto what your ingest server is doing -- nothing here is stored anywhere but this
        browser.
      </p>
      <form className="card" onSubmit={submit}>
        <label htmlFor="baseUrl">Server URL</label>
        <input
          id="baseUrl"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.5:8787"
          autoComplete="off"
        />
        <label htmlFor="token">SHEAF_TOKEN</label>
        <input
          id="token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
        <button type="submit">Connect</button>
      </form>
    </div>
  );
}

function Dashboard({
  connection,
  onDisconnect,
}: {
  connection: Connection;
  onDisconnect: () => void;
}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      const result = await fetchHealth(connection.baseUrl, connection.token);
      if (cancelled) return;
      // A poll that fails leaves the last good reading on screen rather than
      // blanking it out -- one missed request over a flaky connection should
      // not read as "the server has no idea what it's doing".
      if (result.ok) {
        setHealth(result.health);
        setError(null);
      } else {
        setError(result.message);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);

  return (
    <div className="page">
      <h1>Sheaf admin</h1>
      <p className="subtitle">{connection.baseUrl}</p>

      {error === null ? null : <p className="error">Couldn't reach the server: {error}</p>}

      {health === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="card">
            <h2>Storage</h2>
            <div className="row">
              <span>Documents held</span>
              <span>{health.documents}</span>
            </div>
          </div>

          {health.forwarding === undefined ? (
            <div className="card">
              <h2>Forwarding</h2>
              <p className="muted">
                Not configured. Set <code>PAPERLESS_URL</code> to forward documents on and enable
                browsing and suggestions.
              </p>
            </div>
          ) : (
            <>
              <div className="card">
                <h2>Forwarding to {health.forwarding.target}</h2>
                {Object.entries(health.forwarding.counts).map(([state, count]) => (
                  <div className="row" key={state}>
                    <span>{state}</span>
                    <span>{count}</span>
                  </div>
                ))}
                {Object.keys(health.forwarding.counts).length === 0 ? (
                  <p className="muted">Nothing forwarded yet.</p>
                ) : null}
              </div>

              <div className="card">
                <h2>Reconciliation</h2>
                <ReconciliationRow reconciliation={health.forwarding.reconciliation} />
              </div>

              <div className="card">
                <h2>Retention</h2>
                <RetentionRow retention={health.forwarding.retention} />
              </div>
            </>
          )}
        </>
      )}

      <button className="secondary" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

function ReconciliationRow({
  reconciliation,
}: {
  reconciliation: NonNullable<HealthResponse['forwarding']>['reconciliation'];
}) {
  if (reconciliation === undefined) {
    return <p className="muted">Probing…</p>;
  }
  if (!reconciliation.conclusive) {
    return <p className="badge neutral">○ Inconclusive -- {reconciliation.detail}</p>;
  }
  return reconciliation.filterSupported ? (
    <p className="badge ok">✓ Filter works as expected</p>
  ) : (
    <p className="badge danger">✕ Filter is being ignored -- {reconciliation.detail}</p>
  );
}

function RetentionRow({
  retention,
}: {
  retention: NonNullable<HealthResponse['forwarding']>['retention'];
}) {
  if (retention === undefined) {
    return (
      <p className="muted">
        Off. Set <code>SHEAF_RETENTION_DAYS</code> to free bytes once Paperless confirms a document.
      </p>
    );
  }
  return (
    <>
      <div className="row">
        <span>Freed after</span>
        <span>
          {retention.days} {retention.days === 1 ? 'day' : 'days'}
        </span>
      </div>
      <div className="row">
        <span>Documents released</span>
        <span>{retention.released}</span>
      </div>
    </>
  );
}
