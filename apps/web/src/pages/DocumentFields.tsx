import { useEffect, useState } from 'react';
import type {
  CustomField,
  CustomFieldValue,
  DocumentCustomField,
  MonetaryValue,
  SearchHit,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { fromInput, toInput } from '../custom-field-input';
import { shortSha } from '../format';
import { href } from '../route';

interface Draft {
  readonly field: CustomField;
  readonly text: string;
  /** For an amount of money only. */
  readonly currency: string;
}

/** A document's custom fields: fill them in, add one, remove one, then save. */
export function DocumentFields({
  api,
  sha256,
  onChange,
}: {
  api: Api;
  sha256: string;
  onChange: () => void;
}) {
  const [definitions, setDefinitions] = useState<readonly CustomField[]>([]);
  const [drafts, setDrafts] = useState<readonly Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // A reply for a document this form has moved on from must not fill it in.
    let current = true;
    void (async () => {
      const [defs, values] = await Promise.all([
        api.customFields(),
        api.documentCustomFields(sha256),
      ]);
      if (!current) return;
      if (!defs.ok || !values.ok) {
        setError(!defs.ok ? defs.message : !values.ok ? values.message : null);
        return;
      }
      setDefinitions(defs.value.fields);
      setDrafts(toDrafts(defs.value.fields, values.value.values));
    })();
    return () => {
      current = false;
    };
  }, [api, sha256]);

  const update = (field: number, change: Partial<Draft>) => {
    setSaved(false);
    setDrafts((current) => current.map((d) => (d.field.id === field ? { ...d, ...change } : d)));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const values: CustomFieldValue[] = [];
    for (const draft of drafts) {
      const value = fromInput(draft.field.type, draft.text, draft.currency);
      if (value === undefined) {
        setError(`${draft.field.name}: that is not a valid value.`);
        return;
      }
      values.push({ field: draft.field.id, value });
    }
    const result = await api.setDocumentCustomFields(sha256, values);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDrafts(toDrafts(definitions, result.value.values));
    setError(null);
    setSaved(true);
    onChange();
  };

  if (definitions.length === 0) {
    return (
      <section>
        <h2>Fields</h2>
        <p className="muted">
          No custom fields yet. <a href={href({ page: 'fields' })}>Make one</a>.
        </p>
      </section>
    );
  }

  const unused = definitions.filter((d) => !drafts.some((draft) => draft.field.id === d.id));

  return (
    <section>
      <h2>Fields</h2>
      <form className="custom-fields" onSubmit={(event) => void save(event)}>
        {drafts.map((draft) => (
          <div key={draft.field.id} className="custom-field">
            <label htmlFor={`cf-${String(draft.field.id)}`}>{draft.field.name}</label>
            <div className="custom-field-row">
              <FieldInput api={api} sha256={sha256} draft={draft} update={update} />
              <button
                type="button"
                className="link"
                aria-label={`Remove ${draft.field.name}`}
                onClick={() =>
                  setDrafts((current) => current.filter((d) => d.field.id !== draft.field.id))
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {unused.length === 0 ? null : (
          <>
            <label htmlFor="add-field">Add a field</label>
            <select
              id="add-field"
              value=""
              onChange={(event) => {
                const field = definitions.find((d) => d.id === Number(event.target.value));
                if (field !== undefined) {
                  setDrafts((current) => [...current, { field, text: '', currency: 'EUR' }]);
                }
              }}
            >
              <option value="">Choose…</option>
              {unused.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
          </>
        )}
        <p>
          <button type="submit">Save fields</button>{' '}
          {saved ? <span className="badge ok">Saved</span> : null}
        </p>
      </form>
      {error === null ? null : <p className="error">{error}</p>}
    </section>
  );
}

function FieldInput({
  api,
  sha256,
  draft,
  update,
}: {
  api: Api;
  sha256: string;
  draft: Draft;
  update: (field: number, change: Partial<Draft>) => void;
}) {
  const id = `cf-${String(draft.field.id)}`;
  const set = (text: string) => update(draft.field.id, { text });
  switch (draft.field.type) {
    case 'boolean':
      return (
        <select id={id} value={draft.text} onChange={(event) => set(event.target.value)}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'select':
      return (
        <select id={id} value={draft.text} onChange={(event) => set(event.target.value)}>
          <option value="">—</option>
          {draft.field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'date':
      return <input id={id} type="date" value={draft.text} onChange={(e) => set(e.target.value)} />;
    case 'url':
      return <input id={id} type="url" value={draft.text} onChange={(e) => set(e.target.value)} />;
    case 'integer':
    case 'number':
      return (
        <input
          id={id}
          inputMode={draft.field.type === 'integer' ? 'numeric' : 'decimal'}
          value={draft.text}
          onChange={(e) => set(e.target.value)}
        />
      );
    case 'monetary':
      return (
        <span className="money-input">
          <input
            id={id}
            inputMode="decimal"
            value={draft.text}
            onChange={(e) => set(e.target.value)}
          />
          <input
            aria-label={`${draft.field.name} currency`}
            className="currency"
            maxLength={3}
            value={draft.currency}
            onChange={(e) => update(draft.field.id, { currency: e.target.value.toUpperCase() })}
          />
        </span>
      );
    case 'documentLink':
      return <LinkPicker api={api} sha256={sha256} id={id} draft={draft} set={set} />;
    case 'text':
      return <input id={id} value={draft.text} onChange={(e) => set(e.target.value)} />;
  }
}

/** Linked documents as links, and a search to add another. */
function LinkPicker({
  api,
  sha256,
  id,
  draft,
  set,
}: {
  api: Api;
  sha256: string;
  id: string;
  draft: Draft;
  set: (text: string) => void;
}) {
  const linked = draft.text === '' ? [] : draft.text.split(',');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[]>([]);

  useEffect(() => {
    if (query.trim() === '') {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void api.search(query).then((result) => {
        if (result.ok) setHits(result.value.hits.slice(0, 5));
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [api, query]);

  return (
    <div className="link-picker">
      <ul className="links">
        {linked.map((other) => (
          <li key={other}>
            <a href={href({ page: 'document', sha256: other })}>{shortSha(other)}</a>{' '}
            <button
              type="button"
              className="link"
              onClick={() => set(linked.filter((l) => l !== other).join(','))}
            >
              Unlink
            </button>
          </li>
        ))}
      </ul>
      <input
        id={id}
        placeholder="Search for a document to link"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="links">
        {hits
          .filter((hit) => hit.sha256 !== sha256 && !linked.includes(hit.sha256))
          .map((hit) => (
            <li key={hit.sha256}>
              <button
                type="button"
                className="link"
                onClick={() => {
                  set([...linked, hit.sha256].join(','));
                  setQuery('');
                }}
              >
                Link “{hit.title ?? hit.suggestedTitle ?? shortSha(hit.sha256)}”
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function toDrafts(
  definitions: readonly CustomField[],
  values: readonly DocumentCustomField[],
): Draft[] {
  return values.flatMap((value) => {
    const field = definitions.find((d) => d.id === value.field);
    if (field === undefined) return [];
    const currency =
      field.type === 'monetary' && value.value !== null
        ? (value.value as MonetaryValue).currency
        : 'EUR';
    return [{ field, text: toInput(field.type, value.value), currency }];
  });
}
