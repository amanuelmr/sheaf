import { useEffect, useState } from 'react';
import type { DocumentVersion } from '@sheaf/protocol';
import type { Api } from '../api';
import { shortSha, when } from '../format';
import { initialRows, move, pagesToSend, parseParts, turn, type PageRow } from '../page-edit';
import { href } from '../route';

/** Turn, remove, reorder or split a document's pages, and see its earlier files. */
export function Pages({ api, sha256 }: { api: Api; sha256: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<readonly PageRow[]>([]);
  const [versions, setVersions] = useState<readonly DocumentVersion[]>([]);
  const [parts, setParts] = useState('');
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [made, setMade] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([api.pageCount(sha256), api.versions(sha256)]).then(([pages, list]) => {
      if (!current) return;
      if (pages.ok) {
        setCount(pages.value.pages);
        setRows(initialRows(pages.value.pages));
      }
      if (list.ok) setVersions(list.value.versions);
    });
    return () => {
      current = false;
    };
  }, [api, sha256]);

  const goTo = (next: string) => {
    window.location.hash = href({ page: 'document', sha256: next });
  };

  const save = async () => {
    const pages = pagesToSend(rows);
    if (pages === null) return;
    const result = await api.editPages(sha256, pages);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    goTo(result.value.sha256);
  };

  const split = async () => {
    const chosen = count === null ? null : parseParts(parts, count);
    if (chosen === null) {
      setError(
        `Parts like "1-2; 3-${String(count ?? 3)}", within the ${String(count ?? 0)} pages.`,
      );
      return;
    }
    const result = await api.split(sha256, chosen, keepOriginal);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setMade(result.value.documents);
  };

  const restore = async (version: string) => {
    const result = await api.restoreVersion(sha256, version);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    goTo(result.value.sha256);
  };

  const view = async (version: string) => {
    const result = await api.versionPdf(sha256, version);
    if (result.ok) window.open(result.value, '_blank', 'noopener');
    else setError(result.message);
  };

  if (count === null) return null;
  const changed = pagesToSend(rows) !== null;
  const left = rows.filter((row) => !row.removed).length;

  return (
    <section>
      <h2>Pages</h2>
      <p className="muted small">
        {count} page{count === 1 ? '' : 's'}.{' '}
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Turn, remove, reorder or split'}
        </button>
      </p>
      {open ? (
        <>
          <ol className="page-rows">
            {rows.map((row, i) => (
              <li key={row.page} className={row.removed ? 'removed' : undefined}>
                <span>
                  Page {row.page}
                  {row.rotate === 0 ? '' : `, turned ${String(row.rotate)}°`}
                </span>
                <span className="actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Turn page ${String(row.page)} left`}
                    onClick={() => setRows(turn(rows, i, 270))}
                  >
                    ⟲
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Turn page ${String(row.page)} right`}
                    onClick={() => setRows(turn(rows, i, 90))}
                  >
                    ⟳
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move page ${String(row.page)} up`}
                    onClick={() => setRows(move(rows, i, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move page ${String(row.page)} down`}
                    onClick={() => setRows(move(rows, i, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setRows(rows.map((r, j) => (j === i ? { ...r, removed: !r.removed } : r)))
                    }
                  >
                    {row.removed ? 'Keep' : 'Remove'}
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <p className="actions">
            <button type="button" disabled={!changed || left === 0} onClick={() => void save()}>
              Save pages
            </button>
            <span className="muted small">The current file is kept as an earlier version.</span>
          </p>

          <label htmlFor="split-parts">Split into documents</label>
          <span className="asn-input">
            <input
              id="split-parts"
              placeholder="1-2; 3-5"
              value={parts}
              onChange={(event) => setParts(event.target.value)}
            />
            <button
              type="button"
              className="secondary"
              disabled={parts.trim() === ''}
              onClick={() => void split()}
            >
              Split
            </button>
          </span>
          <label className="check">
            <input
              type="checkbox"
              checked={keepOriginal}
              onChange={(event) => setKeepOriginal(event.target.checked)}
            />{' '}
            Keep this document too (otherwise it goes to the trash)
          </label>
          {made.length === 0 ? null : (
            <p>
              Made{' '}
              {made.map((doc, i) => (
                <span key={doc}>
                  {i === 0 ? '' : ', '}
                  <a href={href({ page: 'document', sha256: doc })}>{shortSha(doc)}</a>
                </span>
              ))}
              .
            </p>
          )}
        </>
      ) : null}

      {versions.length === 0 ? null : (
        <>
          <h3>Earlier versions</h3>
          <ul className="links share-links">
            {versions.map((version) => (
              <li key={version.sha256}>
                <span>
                  {shortSha(version.sha256)} ·{' '}
                  {version.pageCount === null ? '' : `${String(version.pageCount)} pages · `}
                  replaced {when(version.replacedAt)}
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void view(version.sha256)}
                >
                  View
                </button>
                <button type="button" className="link" onClick={() => void restore(version.sha256)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error === null ? null : <p className="error">{error}</p>}
    </section>
  );
}
