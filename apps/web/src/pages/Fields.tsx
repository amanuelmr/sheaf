import { useCallback, useEffect, useState } from 'react';
import { CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';

/** Each kind's name, marked here and put through `t` where it is drawn. */
export const TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: mark('Text'),
  boolean: mark('Yes / no'),
  date: mark('Date'),
  url: mark('Link (URL)'),
  integer: mark('Whole number'),
  number: mark('Number'),
  monetary: mark('Amount of money'),
  documentLink: mark('Other documents'),
  select: mark('Choice from a list'),
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
      <h1>{t('Fields')}</h1>
      <p className="subtitle">
        {t('Details you want to keep on documents, like an invoice number or a warranty date.')}
      </p>
      {error === null ? null : <p className="error">{error}</p>}

      {fields === null ? <p className="muted">{t('Loading…')}</p> : null}
      {fields !== null && fields.length === 0 ? (
        <p className="muted">{t('No fields yet.')}</p>
      ) : null}
      <ul className="list">
        {(fields ?? []).map((field) => (
          <li key={field.id} id={`field-${String(field.id)}`}>
            <div>
              <strong>{field.name}</strong>
              <span className="muted">
                {t(TYPE_LABELS[field.type])}
                {field.type === 'select' ? `: ${field.options.join(', ')}` : ''} ·{' '}
                {field.documentCount === 1
                  ? t('on 1 document')
                  : t('on {count} documents', { count: field.documentCount })}
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
                {t('Every document needs it')}
              </label>
            </div>
            {confirming === field.id ? (
              <div className="actions">
                <button type="button" className="danger" onClick={() => void remove(field.id)}>
                  {t('Delete it and its values')}
                </button>
                <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                  {t('Keep it')}
                </button>
              </div>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirming(field.id)}>
                {t('Delete…')}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>{t('New field')}</h2>
      <form className="card" onSubmit={(event) => void create(event)}>
        <label htmlFor="field-name">{t('Name')}</label>
        <input id="field-name" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="field-type">{t('Kind')}</label>
        <select
          id="field-type"
          value={type}
          onChange={(event) => setType(event.target.value as CustomFieldType)}
        >
          {CUSTOM_FIELD_TYPES.map((kind) => (
            <option key={kind} value={kind}>
              {t(TYPE_LABELS[kind])}
            </option>
          ))}
        </select>
        {type === 'select' ? (
          <>
            <label htmlFor="field-options">{t('Choices, one per line')}</label>
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
          {t('Every document needs it')}
        </label>
        <button type="submit" disabled={name.trim() === ''}>
          {t('Add field')}
        </button>
      </form>
    </div>
  );
}
