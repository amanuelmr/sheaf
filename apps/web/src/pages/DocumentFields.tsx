import { useEffect, useState } from 'react';
import type {
  CustomField,
  CustomFieldSuggestion,
  CustomFieldValue,
  DocumentCustomField,
  MonetaryValue,
  SearchHit,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { t } from '../i18n';
import { fromInput, toInput } from '../custom-field-input';
import { shortSha } from '../format';
import { href } from '../route';
import { Status, type Problem } from '../status';

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
  const [error, setError] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly CustomFieldSuggestion[]>([]);

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
        setError(!defs.ok ? defs : !values.ok ? values : null);
        return;
      }
      setDefinitions(defs.value.fields);
      setDrafts(toDrafts(defs.value.fields, values.value.values));
      const learned = await api.fieldSuggestions(sha256);
      if (current && learned.ok) setSuggestions(learned.value.suggestions);
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
        setError(t('{field}: that is not a valid value.', { field: draft.field.name }));
        return;
      }
      values.push({ field: draft.field.id, value });
    }
    const result = await api.setDocumentCustomFields(sha256, values);
    if (!result.ok) {
      setError(result);
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
        <h2>{t('Fields')}</h2>
        <p className="muted">
          {t('No custom fields yet.')} <a href={href({ page: 'fields' })}>{t('Make one')}</a>
        </p>
      </section>
    );
  }

  const unused = definitions.filter((d) => !drafts.some((draft) => draft.field.id === d.id));
  // Offered while the field is still empty here, whether or not it is on the form yet.
  const offered = suggestions.flatMap((s) => {
    const field = definitions.find((d) => d.id === s.field);
    const draft = drafts.find((d) => d.field.id === s.field);
    return field === undefined || (draft !== undefined && draft.text !== '')
      ? []
      : [{ suggestion: s, field }];
  });
  const use = (field: CustomField, value: CustomFieldSuggestion['value']) => {
    const text = toInput(field.type, value);
    setSaved(false);
    setDrafts((current) =>
      current.some((d) => d.field.id === field.id)
        ? current.map((d) => (d.field.id === field.id ? { ...d, text } : d))
        : [...current, { field, text, currency: 'EUR' }],
    );
  };

  return (
    <section>
      <h2>{t('Fields')}</h2>
      {offered.length === 0 ? null : (
        <ul className="notice field-suggestions">
          {offered.map(({ suggestion, field }) => (
            <li key={field.id}>
              {field.name}: <strong>{toInput(field.type, suggestion.value)}</strong>{' '}
              <span className="muted">
                {t('like {count} documents similar to this one', { count: suggestion.basedOn })}
              </span>{' '}
              <button type="button" className="link" onClick={() => use(field, suggestion.value)}>
                {t('Use')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="custom-fields" onSubmit={(event) => void save(event)}>
        {drafts.map((draft) => (
          <div key={draft.field.id} className="custom-field">
            <label htmlFor={`cf-${String(draft.field.id)}`}>
              {draft.field.name}
              {draft.field.required ? <span className="muted"> · needed</span> : null}
            </label>
            <div className="custom-field-row">
              <FieldInput api={api} sha256={sha256} draft={draft} update={update} />
              {draft.field.required ? null : (
                <button
                  type="button"
                  className="link"
                  aria-label={t('Remove {name}', { name: draft.field.name })}
                  onClick={() =>
                    setDrafts((current) => current.filter((d) => d.field.id !== draft.field.id))
                  }
                >
                  {t('Remove')}
                </button>
              )}
            </div>
          </div>
        ))}
        {unused.length === 0 ? null : (
          <>
            <label htmlFor="add-field">{t('Add a field')}</label>
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
              <option value="">{t('Choose…')}</option>
              {unused.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
          </>
        )}
        <p>
          <button type="submit">{t('Save fields')}</button>{' '}
          <Status ok={saved ? t('Saved') : null} inline />
        </p>
      </form>
      <Status error={error} />
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
          <option value="true">{t('Yes')}</option>
          <option value="false">{t('No')}</option>
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
              {t('Unlink')}
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
  const drafts = values.flatMap((value) => {
    const field = definitions.find((d) => d.id === value.field);
    if (field === undefined) return [];
    const currency =
      field.type === 'monetary' && value.value !== null
        ? (value.value as MonetaryValue).currency
        : 'EUR';
    return [{ field, text: toInput(field.type, value.value), currency }];
  });
  // A field every document needs is always there to fill in, even before it has a value.
  for (const field of definitions) {
    if (field.required && !drafts.some((d) => d.field.id === field.id)) {
      drafts.push({ field, text: '', currency: 'EUR' });
    }
  }
  return drafts;
}
