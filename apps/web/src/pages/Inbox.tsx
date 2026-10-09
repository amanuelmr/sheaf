import { useCallback, useEffect, useState } from 'react';
import type { InboxEntry } from '@sheaf/protocol';
import type { Api } from '../api';
import { shortSha, when } from '../format';
import { href } from '../route';

/** Fired when the inbox changes, so the count in the navigation can follow. */
export const INBOX_CHANGED = 'sheaf:inbox-changed';

/**
 * Suggested details waiting for a person, keyboard first: j and k move, a accepts,
 * e opens the document to change it.
 */
export function Inbox({ api }: { api: Api }) {
  const [entries, setEntries] = useState<readonly InboxEntry[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.inbox();
    if (result.ok) setEntries(result.value.documents);
    else setError(result.message);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useCallback(
    async (entry: InboxEntry) => {
      const { title, correspondent, documentType, tags } = entry.suggestions;
      const result = await api.patch(entry.sha256, {
        ...(title === undefined ? {} : { title }),
        ...(correspondent === undefined ? {} : { correspondent }),
        ...(documentType === undefined ? {} : { documentType }),
        ...(tags === undefined ? {} : { tags }),
      });
      if (!result.ok) setError(result.message);
      await load();
      window.dispatchEvent(new Event(INBOX_CHANGED));
    },
    [api, load],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (entries === null || entries.length === 0) return;
      if (event.target instanceof HTMLInputElement) return;
      const entry = entries[Math.min(selected, entries.length - 1)]!;
      if (event.key === 'j') setSelected((i) => Math.min(i + 1, entries.length - 1));
      if (event.key === 'k') setSelected((i) => Math.max(i - 1, 0));
      if (event.key === 'a') void accept(entry);
      if (event.key === 'e')
        window.location.hash = href({ page: 'document', sha256: entry.sha256 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries, selected, accept]);

  if (entries === null)
    return error === null ? <p className="muted">Loading…</p> : <p className="error">{error}</p>;

  return (
    <>
      <h1>To review</h1>
      <p className="muted">
        <kbd>j</kbd> <kbd>k</kbd> to move, <kbd>a</kbd> to accept, <kbd>e</kbd> to edit.
      </p>
      {error === null ? null : <p className="error">{error}</p>}
      {entries.length === 0 ? (
        <p className="muted">Nothing waiting. Everything read has been filed.</p>
      ) : null}
      <ul className="list">
        {entries.map((entry, i) => {
          const s = entry.suggestions;
          return (
            <li key={entry.sha256} className={i === selected ? 'selected' : undefined}>
              <div>
                <strong>{s.title ?? entry.title ?? `Scan ${shortSha(entry.sha256)}`}</strong>
                <span className="muted">
                  {[s.correspondent, s.documentType, s.date, when(entry.receivedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {s.tags === undefined || s.tags.length === 0 ? null : (
                  <span className="muted">{s.tags.join(', ')}</span>
                )}
              </div>
              <div className="actions">
                <button onClick={() => void accept(entry)}>Accept</button>
                <a
                  className="button secondary"
                  href={href({ page: 'document', sha256: entry.sha256 })}
                >
                  Edit
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
