import { useEffect, useMemo, useState } from 'react';
import {
  SEARCH_SORTS,
  type DocumentFilter,
  type Label,
  type LabelKind,
  type SavedView,
  type SearchHit,
  type SearchSort,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { Snippet, shortSha, when } from '../format';
import { href } from '../route';
import { BulkBar } from './BulkBar';
import { INBOX_CHANGED } from './Inbox';

const DEBOUNCE_MS = 200;

const SORT_NAMES: Readonly<Record<SearchSort, string>> = {
  relevance: 'Best match',
  newest: 'Newest first',
  oldest: 'Oldest first',
  title: 'By title',
  created: 'By date on the document',
  asn: 'By serial number',
};

/** A filter being edited, where a part just cleared is still there as `undefined`. */
export type FilterDraft = { [K in keyof DocumentFilter]?: DocumentFilter[K] | undefined };

/** True when the filter asks for nothing, so the dashboard shows instead of results. */
export function isEmptyFilter(filter: DocumentFilter): boolean {
  return Object.entries(filter).every(
    ([key, value]) =>
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (key === 'text' && typeof value === 'string' && value.trim() === ''),
  );
}

/** The filter with empty parts taken out, the way it is saved and put in the address. */
export function tidy(filter: FilterDraft): DocumentFilter {
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([, value]) =>
        value !== undefined &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'string' && value.trim() === ''),
    ),
  );
}

type TagState = 'any' | 'with' | 'without';

function tagState(filter: DocumentFilter, tag: string): TagState {
  if (filter.tags?.includes(tag) === true) return 'with';
  if (filter.notTags?.includes(tag) === true) return 'without';
  return 'any';
}

/** The next state of a tag's toggle: any, then must have, then must not have. */
export function cycleTag(filter: DocumentFilter, tag: string): DocumentFilter {
  const tags = (filter.tags ?? []).filter((t) => t !== tag);
  const notTags = (filter.notTags ?? []).filter((t) => t !== tag);
  const state = tagState(filter, tag);
  if (state === 'any') tags.push(tag);
  if (state === 'with') notTags.push(tag);
  return tidy({ ...filter, tags, notTags });
}

/** The home page: search every word, filter by label and date, and keep filters as views. */
export function Search({ api, initial }: { api: Api; initial?: DocumentFilter }) {
  const [filter, setFilter] = useState<DocumentFilter>(initial ?? {});
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Bumped after a bulk edit, to fetch the results again. */
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Readonly<Record<LabelKind, readonly Label[]>> | null>(null);
  const [views, setViews] = useState<readonly SavedView[]>([]);
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [showFilters, setShowFilters] = useState(() => !isEmptyFilter({ ...initial, text: '' }));

  const empty = isEmptyFilter(filter);

  const loadViews = useMemo(
    () => async () => {
      const result = await api.views();
      if (result.ok) setViews(result.value.views);
    },
    [api],
  );

  useEffect(() => {
    void loadViews();
    void Promise.all([
      api.labels('correspondent'),
      api.labels('documentType'),
      api.labels('tag'),
    ]).then(([correspondent, documentType, tag]) => {
      if (correspondent.ok && documentType.ok && tag.ok) {
        setLabels({
          correspondent: correspondent.value.labels,
          documentType: documentType.value.labels,
          tag: tag.value.labels,
        });
      }
    });
  }, [api, loadViews, reload]);

  // The address follows the filter, so a filtered page can be bookmarked or shared,
  // without adding a history entry per keystroke.
  useEffect(() => {
    const target = href({ page: 'search', filter: tidy(filter) });
    if (window.location.hash !== target) window.history.replaceState(null, '', target);
  }, [filter]);

  useEffect(() => {
    if (empty) {
      setHits(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void api.find(tidy(filter)).then((result) => {
        if (!current) return;
        if (result.ok) {
          setHits(result.value.hits);
          setTotal(result.value.total);
          // Keep only what is still shown: a ticked document that dropped out of the
          // results must not be edited by a bulk action someone cannot see.
          const shown = new Set(result.value.hits.map((hit) => hit.sha256));
          setSelected((current) => new Set([...current].filter((sha) => shown.has(sha))));
          setError(null);
        } else {
          setError(result.message);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, filter, empty, reload]);

  const change = (next: FilterDraft) => setFilter(tidy(next));
  const open = (view: SavedView) => {
    setActiveView(view);
    setFilter(view.filter);
    setShowFilters(true);
  };

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
        value={filter.text ?? ''}
        onChange={(event) => setFilter({ ...filter, text: event.target.value })}
        autoFocus
      />

      <div className="view-bar">
        <button
          type="button"
          className="secondary"
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
        >
          Filters{empty ? '' : ' •'}
        </button>
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className="secondary chip"
            aria-pressed={activeView?.id === view.id}
            onClick={() => open(view)}
          >
            {view.name}
          </button>
        ))}
        {empty ? null : (
          <button
            type="button"
            className="link"
            onClick={() => {
              setFilter({});
              setActiveView(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {showFilters ? <FilterPanel filter={filter} labels={labels} onChange={change} /> : null}
      {error === null ? null : <p className="error">{error}</p>}

      {hits === null ? (
        <Dashboard api={api} views={views} labels={labels} onOpen={open} />
      ) : (
        <>
          <ViewControls
            api={api}
            filter={tidy(filter)}
            active={activeView}
            onSaved={(view) => {
              setActiveView(view);
              void loadViews();
            }}
            onDeleted={() => {
              setActiveView(null);
              void loadViews();
            }}
          />
          <p className="muted small">
            {String(total)} document{total === 1 ? '' : 's'}
          </p>
          {hits.length === 0 ? (
            <p className="muted">Nothing matches.</p>
          ) : (
            <>
              <BulkBar
                api={api}
                hits={hits}
                labels={labels}
                selected={selected}
                setSelected={setSelected}
                onDone={() => {
                  setReload((n) => n + 1);
                  window.dispatchEvent(new Event(INBOX_CHANGED));
                }}
              />
              <HitList
                hits={hits}
                labels={labels}
                selected={selected}
                onSelect={(sha256, on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (on) next.add(sha256);
                    else next.delete(sha256);
                    return next;
                  })
                }
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function HitList({
  hits,
  labels,
  selected,
  onSelect,
}: {
  hits: readonly SearchHit[];
  labels: Readonly<Record<LabelKind, readonly Label[]>> | null;
  /** With these two, each row can be ticked for a bulk edit. */
  selected?: ReadonlySet<string>;
  onSelect?: (sha256: string, on: boolean) => void;
}) {
  const colour = (tag: string) => labels?.tag.find((t) => t.name === tag)?.colour ?? null;
  return (
    <ul className="list">
      {hits.map((hit) => (
        <li
          key={hit.sha256}
          className={selected?.has(hit.sha256) === true ? 'selected' : undefined}
        >
          {selected === undefined || onSelect === undefined ? null : (
            <input
              type="checkbox"
              aria-label={`Select ${hit.title ?? hit.suggestedTitle ?? shortSha(hit.sha256)}`}
              checked={selected.has(hit.sha256)}
              onChange={(event) => onSelect(hit.sha256, event.target.checked)}
            />
          )}
          <a href={href({ page: 'document', sha256: hit.sha256 })}>
            <strong>{hit.title ?? hit.suggestedTitle ?? `Scan ${shortSha(hit.sha256)}`}</strong>
            <span className="muted">
              {[
                hit.asn === null ? null : `#${String(hit.asn)}`,
                hit.correspondent,
                hit.documentType,
                hit.created ?? when(hit.receivedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {hit.tags.length === 0 ? null : (
              <span className="tags">
                {hit.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {colour(tag) === null ? null : (
                      <span className="swatch" style={{ background: colour(tag)! }} aria-hidden />
                    )}
                    {tag}
                  </span>
                ))}
              </span>
            )}
            {hit.snippet === '' ? null : (
              <span className="snippet">
                <Snippet text={hit.snippet} />
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FilterPanel({
  filter,
  labels,
  onChange,
}: {
  filter: DocumentFilter;
  labels: Readonly<Record<LabelKind, readonly Label[]>> | null;
  onChange: (filter: FilterDraft) => void;
}) {
  if (labels === null) return <p className="muted">Loading filters…</p>;
  const one = (values: readonly string[] | undefined) => values?.[0] ?? '';
  return (
    <div className="card filters">
      <div className="filter-row">
        <div>
          <label htmlFor="filter-correspondent">Correspondent</label>
          <select
            id="filter-correspondent"
            value={one(filter.correspondents)}
            onChange={(event) =>
              onChange({
                ...filter,
                correspondents: event.target.value === '' ? [] : [event.target.value],
              })
            }
          >
            <option value="">Any</option>
            {labels.correspondent.map((label) => (
              <option key={label.id} value={label.name}>
                {label.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-type">Document type</label>
          <select
            id="filter-type"
            value={one(filter.documentTypes)}
            onChange={(event) =>
              onChange({
                ...filter,
                documentTypes: event.target.value === '' ? [] : [event.target.value],
              })
            }
          >
            <option value="">Any</option>
            {labels.documentType.map((label) => (
              <option key={label.id} value={label.name}>
                {label.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="filter-row">
        <div>
          <label htmlFor="filter-created-from">Dated from</label>
          <input
            id="filter-created-from"
            type="date"
            value={filter.createdFrom ?? ''}
            onChange={(event) =>
              onChange({ ...filter, createdFrom: event.target.value || undefined })
            }
          />
        </div>
        <div>
          <label htmlFor="filter-created-to">Dated to</label>
          <input
            id="filter-created-to"
            type="date"
            value={filter.createdTo ?? ''}
            onChange={(event) =>
              onChange({ ...filter, createdTo: event.target.value || undefined })
            }
          />
        </div>
      </div>
      <div className="filter-row">
        <div>
          <label htmlFor="filter-from">Received from</label>
          <input
            id="filter-from"
            type="date"
            value={filter.receivedFrom ?? ''}
            onChange={(event) =>
              onChange({ ...filter, receivedFrom: event.target.value || undefined })
            }
          />
        </div>
        <div>
          <label htmlFor="filter-to">Received to</label>
          <input
            id="filter-to"
            type="date"
            value={filter.receivedTo ?? ''}
            onChange={(event) =>
              onChange({ ...filter, receivedTo: event.target.value || undefined })
            }
          />
        </div>
        <div>
          <label htmlFor="filter-sort">Order</label>
          <select
            id="filter-sort"
            value={filter.sort ?? ''}
            onChange={(event) =>
              onChange({
                ...filter,
                sort: event.target.value === '' ? undefined : (event.target.value as SearchSort),
              })
            }
          >
            <option value="">Best match, or newest</option>
            {SEARCH_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_NAMES[sort]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {labels.tag.length === 0 ? null : (
        <>
          <span className="label-text">Tags: click once to require, twice to exclude</span>
          <div className="tag-toggles">
            {labels.tag.map((tag) => {
              const state = tagState(filter, tag.name);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`chip tag-toggle ${state}`}
                  aria-label={`${tag.name}: ${state === 'any' ? 'either way' : state === 'with' ? 'must have' : 'must not have'}`}
                  onClick={() => onChange(cycleTag(filter, tag.name))}
                >
                  {state === 'with' ? '+ ' : state === 'without' ? '− ' : ''}
                  {tag.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Save what is shown as a view, or update or delete the view it came from. */
function ViewControls({
  api,
  filter,
  active,
  onSaved,
  onDeleted,
}: {
  api: Api;
  filter: DocumentFilter;
  active: SavedView | null;
  onSaved: (view: SavedView) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState('');
  const [onDashboard, setOnDashboard] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const changed = active !== null && JSON.stringify(tidy(active.filter)) !== JSON.stringify(filter);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await api.createView({ name: name.trim(), filter, onDashboard });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName('');
    setError(null);
    onSaved(result.value);
  };

  if (active !== null) {
    return (
      <div className="view-controls">
        <span>
          View <strong>{active.name}</strong>
        </span>
        {changed ? (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void api.updateView(active.id, { filter }).then((result) => {
                if (result.ok) onSaved(result.value);
              })
            }
          >
            Save changes to this view
          </button>
        ) : null}
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void api.updateView(active.id, { onDashboard: !active.onDashboard }).then((result) => {
              if (result.ok) onSaved(result.value);
            })
          }
        >
          {active.onDashboard ? 'Take off the home page' : 'Show on the home page'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() =>
            void api.deleteView(active.id).then((result) => {
              if (result.ok) onDeleted();
            })
          }
        >
          Delete view
        </button>
      </div>
    );
  }
  return (
    <form className="view-controls" onSubmit={(event) => void save(event)}>
      <input
        aria-label="Name for this view"
        placeholder="Save these results as a view…"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={onDashboard}
          onChange={(event) => setOnDashboard(event.target.checked)}
        />{' '}
        On the home page
      </label>
      <button type="submit" disabled={name.trim() === ''}>
        Save view
      </button>
      {error === null ? null : <span className="error">{error}</span>}
    </form>
  );
}

/** Views on the home page, each with its count and first few documents, then the latest. */
type LabelLists = Readonly<Record<LabelKind, readonly Label[]>> | null;

function Dashboard({
  api,
  views,
  labels,
  onOpen,
}: {
  api: Api;
  views: readonly SavedView[];
  labels: LabelLists;
  onOpen: (view: SavedView) => void;
}) {
  const shown = views.filter((view) => view.onDashboard);
  return (
    <>
      {shown.map((view) => (
        <DashboardView
          key={view.id}
          api={api}
          view={view}
          labels={labels}
          onOpen={() => onOpen(view)}
        />
      ))}
      <DashboardView
        api={api}
        labels={labels}
        view={{ id: 0, name: 'Recent', filter: {}, onDashboard: true, position: 0 }}
      />
    </>
  );
}

function DashboardView({
  api,
  view,
  labels,
  onOpen,
}: {
  api: Api;
  view: SavedView;
  labels: LabelLists;
  onOpen?: () => void;
}) {
  const [result, setResult] = useState<{ hits: readonly SearchHit[]; total: number } | null>(null);
  const size = onOpen === undefined ? 20 : 5;
  useEffect(() => {
    let current = true;
    void api.find(view.filter, size).then((found) => {
      if (current && found.ok) setResult(found.value);
    });
    return () => {
      current = false;
    };
  }, [api, view, size]);

  return (
    <section>
      <h2>
        {onOpen === undefined ? (
          view.name
        ) : (
          <button type="button" className="link heading-link" onClick={onOpen}>
            {view.name}
          </button>
        )}
        {result === null || onOpen === undefined ? null : (
          <span className="count">{result.total}</span>
        )}
      </h2>
      {result === null ? <p className="muted">Loading…</p> : null}
      {result !== null && result.hits.length === 0 ? (
        <p className="muted">
          {onOpen === undefined ? 'Nothing stored yet. Scan something.' : 'Nothing here.'}
        </p>
      ) : null}
      {result === null ? null : <HitList hits={result.hits} labels={labels} />}
    </section>
  );
}
