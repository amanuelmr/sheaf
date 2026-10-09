import { useEffect, useState } from 'react';
import type { DocumentRecord, SearchHit } from '@sheaf/protocol';
import type { Api } from '../api';
import { Snippet, shortSha, when } from '../format';
import { href } from '../route';

const DEBOUNCE_MS = 200;

/** The home page: everything the server holds, searchable by any word in it. */
export function Search({ api }: { api: Api }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [recent, setRecent] = useState<readonly DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.recent().then((result) => {
      if (result.ok) setRecent(result.value.documents.slice(0, 20));
    });
  }, [api]);

  useEffect(() => {
    if (query.trim() === '') {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void api.search(query).then((result) => {
        if (result.ok) {
          setHits(result.value.hits);
          setError(null);
        } else {
          setError(result.message);
        }
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, query]);

  return (
    <>
      <label className="visually-hidden" htmlFor="search">
        Search documents
      </label>
      <input
        id="search"
        className="search"
        type="search"
        placeholder="Search every word in every document"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      {error === null ? null : <p className="error">{error}</p>}

      {hits === null ? (
        <>
          <h2>Recent</h2>
          {recent.length === 0 ? (
            <p className="muted">Nothing stored yet. Scan something.</p>
          ) : null}
          <ul className="list">
            {recent.map((doc) => (
              <li key={doc.sha256}>
                <a href={href({ page: 'document', sha256: doc.sha256 })}>
                  <strong>
                    {doc.title ?? doc.suggestions?.title ?? `Scan ${shortSha(doc.sha256)}`}
                  </strong>
                  <span className="muted">
                    {[doc.correspondent, when(doc.receivedAt)].filter(Boolean).join(' · ')}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : hits.length === 0 ? (
        <p className="muted">No document mentions that.</p>
      ) : (
        <ul className="list">
          {hits.map((hit) => (
            <li key={hit.sha256}>
              <a href={href({ page: 'document', sha256: hit.sha256 })}>
                <strong>{hit.title ?? hit.suggestedTitle ?? `Scan ${shortSha(hit.sha256)}`}</strong>
                <span className="muted">
                  {[hit.correspondent, when(hit.receivedAt)].filter(Boolean).join(' · ')}
                </span>
                <span className="snippet">
                  <Snippet text={hit.snippet} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
