import { useCallback, useEffect, useState } from 'react';
import type { InboxEntry } from '@sheaf/protocol';
import { t } from '../i18n';
import type { Api } from '../api';
import { shortSha, when } from '../format';
import { href } from '../route';
import { Upload } from './Upload';
import { Accuracy } from './Accuracy';
import { Status, type Problem } from '../status';

/** What a key pressed on the list does; nothing with a modifier held. */
export function inboxAction(key: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): 'down' | 'up' | 'accept' | 'edit' | null {
  if (key.ctrlKey || key.metaKey || key.altKey) return null;
  if (key.key === 'j' || key.key === 'ArrowDown') return 'down';
  if (key.key === 'k' || key.key === 'ArrowUp') return 'up';
  if (key.key === 'a') return 'accept';
  if (key.key === 'e') return 'edit';
  return null;
}

/** Fired when the inbox changes, so the count in the navigation can follow. */
export const INBOX_CHANGED = 'sheaf:inbox-changed';

/**
 * Suggested details waiting for a person, keyboard first: with the list focused,
 * j and k (or the arrow keys) move, a accepts, e opens the document to change it.
 */
export function Inbox({ api, canAdd }: { api: Api; canAdd: boolean }) {
  const [entries, setEntries] = useState<readonly InboxEntry[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<Problem | null>(null);

  const load = useCallback(async () => {
    const result = await api.inbox();
    if (result.ok) setEntries(result.value.documents);
    else setError(result);
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
      if (!result.ok) setError(result);
      await load();
      window.dispatchEvent(new Event(INBOX_CHANGED));
    },
    [api, load],
  );

  /**
   * Only on the list itself, and never with a modifier held: Cmd+A selects text,
   * and a key typed into a button or link inside a row is that control's.
   */
  const onKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (entries === null || entries.length === 0) return;
    if (event.target !== event.currentTarget) return;
    const entry = entries[Math.min(selected, entries.length - 1)]!;
    const action = inboxAction(event);
    if (action === null) return;
    event.preventDefault();
    if (action === 'down') setSelected((i) => Math.min(i + 1, entries.length - 1));
    if (action === 'up') setSelected((i) => Math.max(i - 1, 0));
    if (action === 'accept') void accept(entry);
    if (action === 'edit') window.location.hash = href({ page: 'document', sha256: entry.sha256 });
  };

  if (entries === null)
    return (
      <>
        <Status error={error} />
        {error === null ? <p className="muted">{t('Loading…')}</p> : null}
      </>
    );

  return (
    <>
      <h1>{t('To review')}</h1>
      {canAdd ? <Upload api={api} onDone={() => void load()} /> : null}
      <Accuracy api={api} />
      <p className="muted" id="inbox-keys">
        {t('In the list:')} <kbd>j</kbd> <kbd>k</kbd> {t('to move')}, <kbd>a</kbd> {t('to accept')},{' '}
        <kbd>e</kbd> {t('to edit')}.
      </p>
      <Status error={error} />
      {entries.length === 0 ? (
        <p className="muted">{t('Nothing waiting. Everything read has been filed.')}</p>
      ) : null}
      <ul
        className="list shortcuts"
        tabIndex={entries.length === 0 ? undefined : 0}
        aria-label={t('Documents to review')}
        aria-describedby="inbox-keys"
        aria-keyshortcuts="j k a e"
        onKeyDown={onKey}
      >
        {entries.map((entry, i) => {
          const s = entry.suggestions;
          return (
            <li
              key={entry.sha256}
              className={i === selected ? 'selected' : undefined}
              aria-current={i === selected ? 'true' : undefined}
            >
              <div>
                <strong>
                  {s.title ?? entry.title ?? t('Scan {id}', { id: shortSha(entry.sha256) })}
                </strong>
                <span className="muted">
                  {[s.correspondent, s.documentType, s.date, when(entry.receivedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {s.tags === undefined || s.tags.length === 0 ? null : (
                  <span className="muted">{s.tags.join(', ')}</span>
                )}
                {entry.looksLike === undefined ? null : (
                  <span className="badge waiting wrap">
                    {t('Looks like a re-scan of')}{' '}
                    <a href={href({ page: 'document', sha256: entry.looksLike.sha256 })}>
                      {entry.looksLike.title ??
                        t('Scan {id}', { id: shortSha(entry.looksLike.sha256) })}
                    </a>
                  </span>
                )}
              </div>
              <div className="actions">
                <button onClick={() => void accept(entry)}>{t('Accept')}</button>
                <a
                  className="button secondary"
                  href={href({ page: 'document', sha256: entry.sha256 })}
                >
                  {t('Edit')}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
