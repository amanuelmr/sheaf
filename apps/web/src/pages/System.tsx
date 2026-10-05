import { useEffect, useState } from 'react';
import type { HealthResponse } from '@sheaf/protocol';
import type { Api } from '../api';

const POLL_MS = 5_000;

/** The server's own health: documents held, forwarding, reconciliation, retention. */
export function System({ api }: { api: Api }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      const result = await api.health();
      if (cancelled) return;
      // A poll that fails leaves the last good reading on screen rather than
      // blanking it out -- one missed request over a flaky connection should
      // not read as "the server has no idea what it's doing".
      if (result.ok) {
        setHealth(result.value);
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
  }, [api]);

  return (
    <>
      <h1>System</h1>

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
                No connectors. Documents are kept and searched here. Add Paperless with{' '}
                <code>compose.paperless.yml</code> to send each one on as well.
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
    </>
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
