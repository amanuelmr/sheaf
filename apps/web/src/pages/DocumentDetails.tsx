import { useEffect, useState } from 'react';
import {
  asnFromLabel,
  asnLabel,
  type AsnSeries,
  type DocumentPatch,
  type DocumentRecord,
  type Label,
  type LabelKind,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { useAsnSeries } from '../asn-series';

export interface DetailsDraft {
  readonly title: string;
  readonly created: string;
  readonly correspondent: string;
  readonly documentType: string;
  readonly tags: readonly string[];
  /** As typed: `42`, `B-42` in a series, or empty for none. */
  readonly asn: string;
}

/** The form's starting point: what the document has, or what was suggested for it. */
export function draftOf(record: DocumentRecord, series: readonly AsnSeries[] = []): DetailsDraft {
  return {
    title: record.title ?? record.suggestions?.title ?? '',
    created: record.created ?? record.suggestions?.date ?? '',
    correspondent: record.correspondent ?? '',
    documentType: record.documentType ?? '',
    tags: record.tags,
    asn: record.asn === null ? '' : asnLabel(record.asn, series),
  };
}

/**
 * Only what differs from the document as stored, so saving the form never marks an
 * untouched field as a person's choice. Null when the serial number is not one.
 */
export function detailsPatch(
  record: DocumentRecord,
  draft: DetailsDraft,
  series: readonly AsnSeries[] = [],
): DocumentPatch | null {
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  const asnText = draft.asn.trim();
  const asn = asnText === '' ? null : asnFromLabel(asnText, series);
  if (asnText !== '' && asn === null) return null;
  const tags = [...new Set(draft.tags.map((t) => t.trim()).filter((t) => t !== ''))];
  const patch: { -readonly [K in keyof DocumentPatch]: DocumentPatch[K] } = {};
  if (text(draft.title) !== record.title) patch.title = text(draft.title);
  if (text(draft.created) !== record.created) patch.created = text(draft.created);
  if (text(draft.correspondent) !== record.correspondent) {
    patch.correspondent = text(draft.correspondent);
  }
  if (text(draft.documentType) !== record.documentType) {
    patch.documentType = text(draft.documentType);
  }
  if (tags.length !== record.tags.length || tags.some((t, i) => t !== record.tags[i])) {
    patch.tags = tags;
  }
  if (asn !== record.asn) patch.asn = asn;
  return patch;
}

/** Edit what a document is filed under, its date and its serial number, all at once. */
export function DocumentDetails({
  api,
  record,
  onSaved,
}: {
  api: Api;
  record: DocumentRecord;
  onSaved: (record: DocumentRecord) => void;
}) {
  const [draft, setDraft] = useState<DetailsDraft>(() => draftOf(record));
  const [tag, setTag] = useState('');
  const [labels, setLabels] = useState<Readonly<Record<LabelKind, readonly Label[]>> | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const series = useAsnSeries(api);
  const [nextIn, setNextIn] = useState('');
  // The series arrive after the form is first drawn: show the number with its prefix.
  useEffect(() => {
    if (series.length > 0)
      setDraft((current) => ({ ...current, asn: draftOf(record, series).asn }));
  }, [series, record]);

  useEffect(() => {
    void Promise.all([
      api.labels('correspondent'),
      api.labels('documentType'),
      api.labels('tag'),
    ]).then(([c, d, t]) => {
      if (c.ok && d.ok && t.ok) {
        setLabels({
          correspondent: c.value.labels,
          documentType: d.value.labels,
          tag: t.value.labels,
        });
      }
    });
  }, [api]);

  const set = (change: Partial<DetailsDraft>) => {
    setMessage(null);
    setDraft((current) => ({ ...current, ...change }));
  };
  const addTag = () => {
    if (tag.trim() === '') return;
    set({ tags: [...draft.tags, tag.trim()] });
    setTag('');
  };
  const patch = detailsPatch(record, draft, series);
  const unchanged = patch !== null && Object.keys(patch).length === 0;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (patch === null) {
      setMessage({
        ok: false,
        text:
          series.length === 0
            ? 'The serial number must be a whole number.'
            : `The serial number must be a whole number, or one in a series such as ${series[0]!.prefix}-1.`,
      });
      return;
    }
    const result = await api.patch(record.sha256, patch);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setDraft(draftOf(result.value, series));
    setMessage({ ok: true, text: 'Saved' });
    onSaved(result.value);
  };

  const nextAsn = async () => {
    const result = await api.nextAsn(nextIn === '' ? undefined : nextIn);
    if (result.ok) set({ asn: asnLabel(result.value.asn, series) });
    else setMessage({ ok: false, text: result.message });
  };

  return (
    <form className="card details-form" onSubmit={(event) => void save(event)}>
      <label htmlFor="title">Title</label>
      <input
        id="title"
        value={draft.title}
        onChange={(event) => set({ title: event.target.value })}
      />

      <div className="filter-row">
        <div>
          <label htmlFor="created">Date on the document</label>
          <input
            id="created"
            type="date"
            value={draft.created}
            onChange={(event) => set({ created: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="asn">Serial number (ASN)</label>
          <span className="asn-input">
            <input
              id="asn"
              inputMode={series.length === 0 ? 'numeric' : 'text'}
              value={draft.asn}
              onChange={(event) => set({ asn: event.target.value })}
            />
            {series.length === 0 ? null : (
              <select
                aria-label="Series for the next number"
                value={nextIn}
                onChange={(event) => setNextIn(event.target.value)}
              >
                <option value="">Main</option>
                {series.map((s) => (
                  <option key={s.prefix} value={s.prefix}>
                    {s.prefix} · {s.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="secondary" onClick={() => void nextAsn()}>
              Next
            </button>
          </span>
        </div>
      </div>

      <div className="filter-row">
        <div>
          <label htmlFor="correspondent">From</label>
          <input
            id="correspondent"
            list="details-correspondents"
            value={draft.correspondent}
            onChange={(event) => set({ correspondent: event.target.value })}
          />
          <datalist id="details-correspondents">
            {(labels?.correspondent ?? []).map((label) => (
              <option key={label.id} value={label.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor="documentType">Type</label>
          <input
            id="documentType"
            list="details-types"
            value={draft.documentType}
            onChange={(event) => set({ documentType: event.target.value })}
          />
          <datalist id="details-types">
            {(labels?.documentType ?? []).map((label) => (
              <option key={label.id} value={label.name} />
            ))}
          </datalist>
        </div>
      </div>

      <label htmlFor="add-tag">Tags</label>
      <div className="tags editable">
        {draft.tags.map((name) => (
          <span key={name} className="tag">
            {name}{' '}
            <button
              type="button"
              className="link"
              aria-label={`Remove tag ${name}`}
              onClick={() => set({ tags: draft.tags.filter((t) => t !== name) })}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <span className="asn-input">
        <input
          id="add-tag"
          list="details-tags"
          placeholder="Add a tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addTag();
            }
          }}
        />
        <button type="button" className="secondary" onClick={addTag} disabled={tag.trim() === ''}>
          Add
        </button>
      </span>
      <datalist id="details-tags">
        {(labels?.tag ?? [])
          .filter((label) => !draft.tags.includes(label.name))
          .map((label) => (
            <option key={label.id} value={label.name} />
          ))}
      </datalist>

      <p className="actions">
        <button type="submit" disabled={unchanged}>
          Save details
        </button>
        {message === null ? null : (
          <span className={message.ok ? 'badge ok' : 'error'}>{message.text}</span>
        )}
      </p>
    </form>
  );
}
