import { useState } from 'react';
import type { BulkAction, Label, LabelKind, SearchHit } from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';

type Choice =
  | 'setCorrespondent'
  | 'setDocumentType'
  | 'addTag'
  | 'removeTag'
  | 'applyRules'
  | 'merge'
  | 'trash';

const CHOICES: readonly { value: Choice; text: string }[] = [
  { value: 'addTag', text: mark('Add a tag') },
  { value: 'removeTag', text: mark('Remove a tag') },
  { value: 'setCorrespondent', text: mark('Set the correspondent') },
  { value: 'setDocumentType', text: mark('Set the document type') },
  { value: 'applyRules', text: mark('File by the label rules') },
  { value: 'merge', text: mark('Merge into one document') },
  { value: 'trash', text: mark('Move to the trash') },
];

/** The action a choice and its value stand for, or null while a value is still missing. */
export function bulkAction(choice: Choice, value: string): BulkAction | null {
  const name = value.trim();
  switch (choice) {
    case 'setCorrespondent':
      return { kind: 'setCorrespondent', value: name === '' ? null : name };
    case 'setDocumentType':
      return { kind: 'setDocumentType', value: name === '' ? null : name };
    case 'addTag':
      return name === '' ? null : { kind: 'modifyTags', add: [name], remove: [] };
    case 'removeTag':
      return name === '' ? null : { kind: 'modifyTags', add: [], remove: [name] };
    case 'applyRules':
      return { kind: 'applyRules' };
    case 'merge':
      // Not a bulk edit: the bar sends it to the merge route instead.
      return null;
    case 'trash':
      return { kind: 'trash' };
  }
}

/** Tick documents in the results, then change them all at once. */
export function BulkBar({
  api,
  hits,
  labels,
  selected,
  setSelected,
  onDone,
}: {
  api: Api;
  hits: readonly SearchHit[];
  labels: Readonly<Record<LabelKind, readonly Label[]>> | null;
  selected: ReadonlySet<string>;
  setSelected: (selected: ReadonlySet<string>) => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<Choice>('addTag');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const allShown = hits.length > 0 && hits.every((hit) => selected.has(hit.sha256));

  const names =
    labels === null
      ? []
      : choice === 'setCorrespondent'
        ? labels.correspondent
        : choice === 'setDocumentType'
          ? labels.documentType
          : labels.tag;
  const needsValue = choice !== 'applyRules' && choice !== 'trash' && choice !== 'merge';
  const action = bulkAction(choice, value);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    if (choice === 'merge') {
      // In the order shown, which is the order a person reads them in.
      const ordered = hits.map((hit) => hit.sha256).filter((sha) => selected.has(sha));
      const merged = await api.merge(ordered, false);
      if (!merged.ok) {
        setMessage({ ok: false, text: merged.message });
        return;
      }
      setSelected(new Set());
      onDone();
      window.location.hash = `#/doc/${merged.value.sha256}`;
      return;
    }
    if (action === null) return;
    const result = await api.bulkEdit([...selected], action);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    const { changed } = result.value;
    setMessage({
      ok: true,
      text:
        changed === 1
          ? t('Changed 1 document.')
          : t('Changed {count} documents.', { count: changed }),
    });
    setValue('');
    setSelected(new Set());
    onDone();
  };

  return (
    <div className="bulk-bar">
      <label className="check">
        <input
          type="checkbox"
          checked={allShown}
          onChange={(event) =>
            setSelected(event.target.checked ? new Set(hits.map((hit) => hit.sha256)) : new Set())
          }
        />{' '}
        {selected.size === 0
          ? t('Select all shown')
          : t('{count} selected', { count: selected.size })}
      </label>
      {selected.size === 0 ? null : (
        <form className="bulk-form" onSubmit={(event) => void run(event)}>
          <select
            aria-label={t('What to do with the selected documents')}
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value as Choice);
              setValue('');
            }}
          >
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.text)}
              </option>
            ))}
          </select>
          {needsValue ? (
            <>
              <input
                aria-label={t('Name')}
                list="bulk-names"
                placeholder={
                  choice === 'setCorrespondent' || choice === 'setDocumentType'
                    ? t('Name (empty clears it)')
                    : t('Tag')
                }
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <datalist id="bulk-names">
                {names.map((label) => (
                  <option key={label.id} value={label.name} />
                ))}
              </datalist>
            </>
          ) : null}
          <button
            type="submit"
            className={choice === 'trash' ? 'danger' : undefined}
            disabled={choice === 'merge' ? selected.size < 2 : action === null}
          >
            {t('Apply to {count}', { count: selected.size })}
          </button>
        </form>
      )}
      {message === null ? null : (
        <span className={message.ok ? 'badge ok' : 'error'}>{message.text}</span>
      )}
    </div>
  );
}
