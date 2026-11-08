import { useCallback, useEffect, useState } from 'react';
import { CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '@sheaf/protocol';
import type { Api } from '../api';

export const TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: 'Text',
  boolean: 'Yes / no',
  date: 'Date',
  url: 'Link (URL)',
  integer: 'Whole number',
  number: 'Number',
  monetary: 'Amount of money',
  documentLink: 'Other documents',
  select: 'Choice from a list',
};

/** Custom fields: the details you want to track that Sheaf does not read on its own. */
export function Fields({ api }: { api: Api }) {
  const [fields, setFields] = useState<readonly CustomField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    const result = await api.customFields();
    if (result.ok) setFields(result.value.fields);
    else setError(result.message);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const choices = options
      .split('\n')
      .map((option) => option.trim())
      .filter((option) => option !== '');
    const result = await api.createCustomField({
      name: name.trim(),
      type,
      ...(type === 'select' ? { options: choices } : {}),
      ...(required ? { required } : {}),
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName('');
    setOptions('');
    setRequired(false);
    setError(null);
    await load();
  };

  const remove = async (id: number) => {
    const result = await api.deleteCustomField(id);
    setConfirming(null);
    if (!result.ok) setError(result.message);
    await load();
  };

  return (
    <div>
      <h1>Fields</h1>
      <p className="subtitle">
        Details you want to keep on documents, like an invoice number or a warranty date.
      </p>
      {error === null ? null : <p className="error">{error}</p>}

      {fields === null ? <p className="muted">Loading…</p> : null}
      {fields !== null && fields.length === 0 ? <p className="muted">No fields yet.</p> : null}
      <ul className="list">
        {(fields ?? []).map((field) => (
          <li key={field.id} id={`field-${String(field.id)}`}>
            <div>
              <strong>{field.name}</strong>
              <span className="muted">
                {TYPE_LABELS[field.type]}
                {field.type === 'select' ? `: ${field.options.join(', ')}` : ''} · on{' '}
                {String(field.documentCount)} document{field.documentCount === 1 ? '' : 's'}
              </span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) =>
                    void api
                      .updateCustomField(field.id, { required: event.target.checked })
                      .then((result) => {
                        if (!result.ok) setError(result.message);
                        return load();
                      })
                  }
                />{' '}
                Every document needs it
              </label>
            </div>
            {confirming === field.id ? (
              <div className="actions">
                <button type="button" className="danger" onClick={() => void remove(field.id)}>
                  Delete it and its values
                </button>
                <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirming(field.id)}>
                Delete…
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>New field</h2>
      <form className="card" onSubmit={(event) => void create(event)}>
        <label htmlFor="field-name">Name</label>
        <input id="field-name" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="field-type">Kind</label>
        <select
          id="field-type"
          value={type}
          onChange={(event) => setType(event.target.value as CustomFieldType)}
        >
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {type === 'select' ? (
          <>
            <label htmlFor="field-options">Choices, one per line</label>
            <textarea
              id="field-options"
              rows={4}
              value={options}
              onChange={(event) => setOptions(event.target.value)}
            />
          </>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />{' '}
          Every document needs it
        </label>
        <button type="submit" disabled={name.trim() === ''}>
          Add field
        </button>
      </form>
    </div>
  );
}
