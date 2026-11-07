import { useEffect, useState } from 'react';
import {
  settingProblem,
  type AuditEntry,
  type HealthResponse,
  type ServerSettings,
  type SettingSource,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { shortSha, when } from '../format';
import { href } from '../route';

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

      <ServerSettingsCard api={api} />

      <RecentChanges api={api} />
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

/** The newest changes made through the API, for an admin; nothing for anyone else. */
function RecentChanges({ api }: { api: Api }) {
  const [entries, setEntries] = useState<readonly AuditEntry[] | null>(null);
  const [more, setMore] = useState(true);

  const load = async (before?: number) => {
    const result = await api.audit(before);
    if (!result.ok) return;
    setEntries((current) => [
      ...(before === undefined ? [] : (current ?? [])),
      ...result.value.entries,
    ]);
    setMore(result.value.entries.length === 50);
  };

  useEffect(() => {
    void load();
  }, [api]);

  if (entries === null) return null;
  return (
    <div className="card">
      <h2>Recent changes</h2>
      {entries.length === 0 ? <p className="muted">Nothing changed yet.</p> : null}
      <ol className="timeline">
        {entries.map((entry) => (
          <li key={entry.id}>
            <time>{when(entry.at)}</time> {entry.who}: {entry.what}
            {entry.sha256 === null ? null : (
              <>
                {' '}
                <a href={href({ page: 'document', sha256: entry.sha256 })}>
                  {shortSha(entry.sha256)}
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
      {more && entries.length > 0 ? (
        <button type="button" className="secondary" onClick={() => void load(entries.at(-1)!.id)}>
          Older
        </button>
      ) : null}
    </div>
  );
}

const SOURCE_TEXT: Readonly<Record<SettingSource, string>> = {
  default: 'built-in default',
  environment: 'from the environment',
  saved: 'saved here',
};

/** Settings an admin can change without restarting the server; nothing for anyone else. */
function ServerSettingsCard({ api }: { api: Api }) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [sources, setSources] = useState<Readonly<
    Record<keyof ServerSettings, SettingSource>
  > | null>(null);
  const [draft, setDraft] = useState<ServerSettings | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api.settings().then((result) => {
      if (!result.ok) return;
      setSettings(result.value.settings);
      setSources(result.value.sources);
      setDraft(result.value.settings);
    });
  }, [api]);

  if (settings === null || draft === null || sources === null) return null;

  const changed = (Object.keys(draft) as (keyof ServerSettings)[]).filter(
    (key) => draft[key] !== settings[key],
  );
  const problem =
    changed.map((key) => settingProblem(key, draft[key])).find((p) => p !== null) ?? null;

  const save = async (patch: Partial<Record<keyof ServerSettings, unknown>>) => {
    const result = await api.updateSettings(patch);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setSettings(result.value.settings);
    setSources(result.value.sources);
    setDraft(result.value.settings);
    setMessage({ ok: true, text: 'Saved' });
  };

  const note = (key: keyof ServerSettings) => (
    <span className="muted small">
      {SOURCE_TEXT[sources[key]]}
      {sources[key] === 'saved' ? (
        <>
          {' · '}
          <button type="button" className="link" onClick={() => void save({ [key]: null })}>
            undo
          </button>
        </>
      ) : null}
    </span>
  );

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void save(Object.fromEntries(changed.map((key) => [key, draft[key]])));
      }}
    >
      <h2>Settings</h2>
      <label htmlFor="set-trash">Days in the trash before deleting for good</label>
      <input
        id="set-trash"
        inputMode="numeric"
        value={String(draft.trashDays)}
        onChange={(event) => setDraft({ ...draft, trashDays: Number(event.target.value) })}
      />
      {note('trashDays')}
      <label htmlFor="set-format">Export file names</label>
      <input
        id="set-format"
        value={draft.filenameFormat}
        onChange={(event) => setDraft({ ...draft, filenameFormat: event.target.value })}
      />
      {note('filenameFormat')}
      <label className="check">
        <input
          type="checkbox"
          checked={draft.barcodesEnabled}
          onChange={(event) => setDraft({ ...draft, barcodesEnabled: event.target.checked })}
        />{' '}
        Read barcodes on new documents
      </label>
      {note('barcodesEnabled')}
      <div className="filter-row">
        <div>
          <label htmlFor="set-separator">Separator page barcode</label>
          <input
            id="set-separator"
            value={draft.barcodeSeparator}
            onChange={(event) => setDraft({ ...draft, barcodeSeparator: event.target.value })}
          />
          {note('barcodeSeparator')}
        </div>
        <div>
          <label htmlFor="set-asn">Serial number barcode prefix</label>
          <input
            id="set-asn"
            value={draft.barcodeAsnPrefix}
            onChange={(event) => setDraft({ ...draft, barcodeAsnPrefix: event.target.value })}
          />
          {note('barcodeAsnPrefix')}
        </div>
      </div>
      {problem === null ? null : <p className="error">{problem}</p>}
      <p className="actions">
        <button type="submit" disabled={changed.length === 0 || problem !== null}>
          Save settings
        </button>
        {message === null ? null : (
          <span className={message.ok ? 'badge ok' : 'error'}>{message.text}</span>
        )}
      </p>
    </form>
  );
}
