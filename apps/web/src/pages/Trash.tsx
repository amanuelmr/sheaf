import { useCallback, useEffect, useState } from 'react';
import type { TrashResponse } from '@sheaf/protocol';
import type { Api } from '../api';

import { shortSha, when } from '../format';
import { t } from '../i18n';
import { href } from '../route';

/**
 * Deleted documents, until the server deletes them for good. Restoring is one click;
 * deleting for good asks again, on the page rather than in a browser dialog.
 */
export function Trash({ api }: { api: Api }) {
  const [trash, setTrash] = useState<TrashResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The document about to be deleted for good, or 'all', awaiting a second click. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.trash();
    if (result.ok) setTrash(result.value);
    else setError(result.message);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: Promise<{ ok: boolean; message?: string }>) => {
    const result = await work;
    setConfirming(null);
    if (!result.ok) setError(result.message ?? t('That did not work.'));
    else setError(null);
    await load();
  };

  if (trash === null) {
    return error === null ? (
      <p className="muted">{t('Loading…')}</p>
    ) : (
      <p className="error">{error}</p>
    );
  }

  return (
    <div>
      <h1>{t('Trash')}</h1>
      <p className="subtitle">
        {t('Deleted documents stay here for {days} days, then are deleted for good.', {
          days: trash.purgeAfterDays,
        })}
      </p>
      {error === null ? null : <p className="error">{error}</p>}
      {trash.documents.length === 0 ? (
        <p className="muted">{t('The trash is empty.')}</p>
      ) : (
        <>
          <ul className="list">
            {trash.documents.map((entry) => (
              <li key={entry.sha256} id={`trash-${entry.sha256}`}>
                <a href={href({ page: 'document', sha256: entry.sha256 })}>
                  <strong>
                    {entry.title ??
                      entry.suggestedTitle ??
                      t('Scan {id}', { id: shortSha(entry.sha256) })}
                  </strong>
                  <span className="muted">
                    {t('Deleted {deleted} · gone for good {gone}', {
                      deleted: when(entry.trashedAt),
                      gone: when(entry.purgeAt),
                    })}
                  </span>
                </a>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void act(api.restore([entry.sha256]))}
                  >
                    {t('Restore')}
                  </button>
                  {confirming === entry.sha256 ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void act(api.emptyTrash([entry.sha256]))}
                    >
                      {t('Really delete?')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setConfirming(entry.sha256)}
                    >
                      {t('Delete for good…')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p>
            {confirming === 'all' ? (
              <>
                <button type="button" className="danger" onClick={() => void act(api.emptyTrash())}>
                  {t('Delete all {count} for good', { count: trash.documents.length })}
                </button>{' '}
                <button type="button" className="link" onClick={() => setConfirming(null)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirming('all')}>
                {t('Empty the trash')}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  );
}
