import { useCallback, useEffect, useState } from 'react';
import type { TrashResponse } from '@sheaf/protocol';
import type { Api } from '../api';
import { shortSha, when } from '../format';
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
    if (!result.ok) setError(result.message ?? 'That did not work.');
    else setError(null);
    await load();
  };

  if (trash === null) {
    return error === null ? <p className="muted">Loading…</p> : <p className="error">{error}</p>;
  }

  return (
    <div>
      <h1>Trash</h1>
      <p className="subtitle">
        Deleted documents stay here for {String(trash.purgeAfterDays)} days, then are deleted for
        good.
      </p>
      {error === null ? null : <p className="error">{error}</p>}
      {trash.documents.length === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <>
          <ul className="list">
            {trash.documents.map((entry) => (
              <li key={entry.sha256} id={`trash-${entry.sha256}`}>
                <a href={href({ page: 'document', sha256: entry.sha256 })}>
                  <strong>
                    {entry.title ?? entry.suggestedTitle ?? `Scan ${shortSha(entry.sha256)}`}
                  </strong>
                  <span className="muted">
                    Deleted {when(entry.trashedAt)} · gone for good {when(entry.purgeAt)}
                  </span>
                </a>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void act(api.restore([entry.sha256]))}
                  >
                    Restore
                  </button>
                  {confirming === entry.sha256 ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void act(api.emptyTrash([entry.sha256]))}
                    >
                      Really delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setConfirming(entry.sha256)}
                    >
                      Delete for good…
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
                  Delete all {String(trash.documents.length)} for good
                </button>{' '}
                <button type="button" className="link" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirming('all')}>
                Empty the trash
              </button>
            )}
          </p>
        </>
      )}
    </div>
  );
}
