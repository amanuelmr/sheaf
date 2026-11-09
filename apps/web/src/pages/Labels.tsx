import { useCallback, useEffect, useState } from 'react';
import {
  LABEL_KINDS,
  MATCHING_ALGORITHMS,
  type Label,
  type LabelKind,
  type MatchingAlgorithm,
  type MatchingRule,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';
import { ALGORITHM_NAMES, describeRule } from '../label-rule';
import { href } from '../route';

/** Each kind's words, marked here and put through `t` where they are drawn. */
const KIND_NAMES: Readonly<
  Record<LabelKind, { plural: string; none: string; heading: string; add: string; remove: string }>
> = {
  tag: {
    plural: mark('Tags'),
    none: mark('No tags yet.'),
    heading: mark('New tag'),
    add: mark('Add tag'),
    remove: mark('Delete tag {name}'),
  },
  correspondent: {
    plural: mark('Correspondents'),
    none: mark('No correspondents yet.'),
    heading: mark('New correspondent'),
    add: mark('Add correspondent'),
    remove: mark('Delete correspondent {name}'),
  },
  documentType: {
    plural: mark('Document types'),
    none: mark('No document types yet.'),
    heading: mark('New document type'),
    add: mark('Add document type'),
    remove: mark('Delete document type {name}'),
  },
};

/** What one row is in the middle of, if anything. */
type Editing =
  | { readonly id: number; readonly mode: 'rename'; readonly text: string }
  | { readonly id: number; readonly mode: 'merge'; readonly into: number | null }
  | { readonly id: number; readonly mode: 'delete' }
  | {
      readonly id: number;
      readonly mode: 'rule';
      readonly rule: MatchingRule;
      readonly inbox: boolean;
      readonly parent: number | null;
    };

/** Tags, correspondents and document types: add, rename, colour, merge and delete. */
export function Labels({ api }: { api: Api }) {
  const [kind, setKind] = useState<LabelKind>('tag');
  const [labels, setLabels] = useState<readonly Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState('');
  const [applied, setApplied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.labels(kind);
    if (result.ok) setLabels(result.value.labels);
    else setError(result.message);
  }, [api, kind]);

  useEffect(() => {
    // A reply for the kind just left must not fill in the one now shown.
    let current = true;
    setLabels(null);
    setEditing(null);
    setError(null);
    void api.labels(kind).then((result) => {
      if (!current) return;
      if (result.ok) setLabels(result.value.labels);
      else setError(result.message);
    });
    return () => {
      current = false;
    };
  }, [api, kind]);

  /** Run one change, then show the list as the server now has it. */
  const apply = async (change: Promise<{ ok: boolean; message?: string }>) => {
    const result = await change;
    if (!result.ok) {
      setError(result.message ?? t('That did not work.'));
      return false;
    }
    setError(null);
    setEditing(null);
    await load();
    return true;
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await apply(api.createLabel(kind, { name: name.trim() }))) setName('');
  };

  const applyRules = async () => {
    setApplied(null);
    const result = await api.applyRules();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const { changed } = result.value;
    setApplied(
      changed === 1 ? t('Filed 1 document.') : t('Filed {count} documents.', { count: changed }),
    );
    await load();
  };

  const names = KIND_NAMES[kind];

  return (
    <div>
      <h1>{t('Labels')}</h1>
      <p className="subtitle">
        {t(
          'The names documents are filed under. Renaming or merging one changes every document that carries it.',
        )}
      </p>
      <div className="tabs" role="group" aria-label={t('Kind of label')}>
        {LABEL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="secondary"
            aria-pressed={k === kind}
            onClick={() => setKind(k)}
          >
            {t(KIND_NAMES[k].plural)}
          </button>
        ))}
      </div>
      {error === null ? null : <p className="error">{error}</p>}

      {labels === null ? <p className="muted">{t('Loading…')}</p> : null}
      {labels !== null && labels.length === 0 ? <p className="muted">{t(names.none)}</p> : null}
      <ul className="list">
        {tree(labels ?? []).map(({ label, depth }) => (
          <li
            key={label.id}
            id={`label-${String(label.id)}`}
            style={depth === 0 ? undefined : { paddingLeft: `${String(8 + depth * 20)}px` }}
          >
            {editing?.id === label.id && editing.mode === 'rename' ? (
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void apply(api.updateLabel(kind, label.id, { name: editing.text.trim() }));
                }}
              >
                <input
                  aria-label={t('New name for {name}', { name: label.name })}
                  // Opened by the Rename button, so typing should go straight in.
                  autoFocus
                  value={editing.text}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                />
                <button type="submit" disabled={editing.text.trim() === ''}>
                  {t('Rename')}
                </button>
                <button type="button" className="secondary" onClick={() => setEditing(null)}>
                  {t('Cancel')}
                </button>
              </form>
            ) : editing?.id === label.id && editing.mode === 'rule' ? (
              <RuleEditor
                label={label}
                tags={labels ?? []}
                editing={editing}
                setEditing={setEditing}
                onSave={() =>
                  void apply(
                    api.updateLabel(kind, label.id, {
                      matching: editing.rule,
                      ...(label.kind === 'tag'
                        ? { inbox: editing.inbox, parent: editing.parent }
                        : {}),
                    }),
                  )
                }
              />
            ) : (
              <div>
                <strong>
                  {label.colour === null ? null : (
                    <span className="swatch" style={{ background: label.colour }} aria-hidden />
                  )}
                  {label.name}
                </strong>
                <span className="muted">
                  <a href={href({ page: 'search', filter: filterFor(label) })}>
                    {label.documents === 1
                      ? t('on 1 document')
                      : t('on {count} documents', { count: label.documents })}
                  </a>
                  {label.inbox ? ` · ${t('added to every new document')}` : ''}
                  {describeRule(label.matching) === null
                    ? ''
                    : ` · ${describeRule(label.matching)}`}
                </span>
              </div>
            )}
            <Actions
              label={label}
              others={(labels ?? []).filter((other) => other.id !== label.id)}
              editing={editing?.id === label.id ? editing : null}
              setEditing={setEditing}
              onColour={(colour) => void apply(api.updateLabel(kind, label.id, { colour }))}
              onMerge={(into) => void apply(api.mergeLabel(kind, label.id, into))}
              onDelete={() => void apply(api.deleteLabel(kind, label.id))}
            />
          </li>
        ))}
      </ul>

      <h2>{t('Rules')}</h2>
      <p className="muted">
        {t(
          'New documents are filed by these rules as they arrive. Rules never change what a person chose.',
        )}
      </p>
      <p>
        <button type="button" className="secondary" onClick={() => void applyRules()}>
          {t('Apply rules to documents already here')}
        </button>{' '}
        {applied === null ? null : <span className="badge ok">{applied}</span>}
      </p>

      <h2>{t(names.heading)}</h2>
      <form className="card" onSubmit={(event) => void create(event)}>
        <label htmlFor="label-name">{t('Name')}</label>
        <input id="label-name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" disabled={name.trim() === ''}>
          {t(names.add)}
        </button>
      </form>
    </div>
  );
}

function Actions({
  label,
  others,
  editing,
  setEditing,
  onColour,
  onMerge,
  onDelete,
}: {
  label: Label;
  others: readonly Label[];
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  onColour: (colour: string | null) => void;
  onMerge: (into: number) => void;
  onDelete: () => void;
}) {
  if (editing?.mode === 'rename' || editing?.mode === 'rule') return null;
  if (editing?.mode === 'delete') {
    return (
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          {label.documents === 1
            ? t('Remove from 1 document')
            : t('Remove from {count} documents', { count: label.documents })}
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>
          {t('Keep it')}
        </button>
      </div>
    );
  }
  if (editing?.mode === 'merge') {
    return (
      <div className="actions">
        <select
          aria-label={t('Merge {name} into', { name: label.name })}
          value={editing.into ?? ''}
          onChange={(event) =>
            setEditing({
              ...editing,
              into: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        >
          <option value="">{t('Merge into…')}</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={editing.into === null}
          onClick={() => editing.into !== null && onMerge(editing.into)}
        >
          {t('Merge')}
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>
          {t('Cancel')}
        </button>
      </div>
    );
  }
  return (
    <div className="actions">
      {label.kind === 'tag' ? (
        <>
          <ColourPicker label={label} onColour={onColour} />
          {label.colour === null ? null : (
            <button type="button" className="link" onClick={() => onColour(null)}>
              {t('No colour')}
            </button>
          )}
        </>
      ) : null}
      <button
        type="button"
        className="secondary"
        onClick={() => setEditing({ id: label.id, mode: 'rename', text: label.name })}
      >
        {t('Rename')}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() =>
          setEditing({
            id: label.id,
            mode: 'rule',
            rule: label.matching,
            inbox: label.inbox,
            parent: label.parent,
          })
        }
      >
        {label.kind === 'tag' ? t('Settings…') : t('Rule…')}
      </button>
      {others.length === 0 ? null : (
        <button
          type="button"
          className="secondary"
          onClick={() => setEditing({ id: label.id, mode: 'merge', into: null })}
        >
          {t('Merge…')}
        </button>
      )}
      <button
        type="button"
        className="secondary"
        aria-label={t(KIND_NAMES[label.kind].remove, { name: label.name })}
        onClick={() => setEditing({ id: label.id, mode: 'delete' })}
      >
        {t('Delete…')}
      </button>
    </div>
  );
}

/** Saves once the picker is closed, not on every step of dragging through colours. */
function ColourPicker({ label, onColour }: { label: Label; onColour: (colour: string) => void }) {
  const [colour, setColour] = useState(label.colour ?? '#888888');
  useEffect(() => setColour(label.colour ?? '#888888'), [label.colour]);
  return (
    <input
      type="color"
      aria-label={t('Colour of {name}', { name: label.name })}
      value={colour}
      onChange={(event) => setColour(event.target.value)}
      onBlur={() => {
        if (colour !== (label.colour ?? '#888888')) onColour(colour);
      }}
    />
  );
}

/** Choose how a label finds its documents, and for a tag whether it marks the inbox. */
function RuleEditor({
  label,
  tags,
  editing,
  setEditing,
  onSave,
}: {
  label: Label;
  /** The other labels of this kind, to choose a parent from. */
  tags: readonly Label[];
  editing: Extract<Editing, { mode: 'rule' }>;
  setEditing: (editing: Editing | null) => void;
  onSave: () => void;
}) {
  const { rule } = editing;
  const set = (change: Partial<MatchingRule>) => {
    const next = { ...rule, ...change };
    setEditing({ ...editing, rule: next.algorithm === 'none' ? { ...next, pattern: '' } : next });
  };
  const id = `rule-${String(label.id)}`;
  return (
    <form
      className="rule-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <strong>{label.name}</strong>
      <label htmlFor={`${id}-algorithm`}>{t('Find it by')}</label>
      <select
        id={`${id}-algorithm`}
        value={rule.algorithm}
        onChange={(event) => set({ algorithm: event.target.value as MatchingAlgorithm })}
      >
        {MATCHING_ALGORITHMS.map((algorithm) => (
          <option key={algorithm} value={algorithm}>
            {t(ALGORITHM_NAMES[algorithm])}
          </option>
        ))}
      </select>
      {rule.algorithm === 'none' ? null : (
        <>
          <label htmlFor={`${id}-pattern`}>
            {rule.algorithm === 'any' || rule.algorithm === 'all'
              ? t('Words (put "a phrase" in quotes)')
              : rule.algorithm === 'regex'
                ? t('Pattern')
                : t('Text')}
          </label>
          <input
            id={`${id}-pattern`}
            value={rule.pattern}
            onChange={(event) => set({ pattern: event.target.value })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={rule.caseSensitive}
              onChange={(event) => set({ caseSensitive: event.target.checked })}
            />{' '}
            {t('Upper and lower case must match')}
          </label>
        </>
      )}
      {label.kind === 'tag' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={editing.inbox}
            onChange={(event) => setEditing({ ...editing, inbox: event.target.checked })}
          />{' '}
          {t('Add to every new document, to mark it as not yet looked at')}
        </label>
      ) : null}
      {label.kind === 'tag' ? (
        <>
          <label htmlFor={`${id}-parent`}>{t('Inside')}</label>
          <select
            id={`${id}-parent`}
            value={editing.parent === null ? '' : String(editing.parent)}
            onChange={(event) =>
              setEditing({
                ...editing,
                parent: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          >
            <option value="">{t('No other tag')}</option>
            {tags
              .filter((tag) => tag.id !== label.id && !within(tags, tag.id, label.id))
              .map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {path(tags, tag)}
                </option>
              ))}
          </select>
        </>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={rule.algorithm !== 'none' && rule.pattern.trim() === ''}>
          {t('Save rule')}
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  );
}

/** The search that lists a label's documents. */
function filterFor(label: Label) {
  switch (label.kind) {
    case 'correspondent':
      return { correspondents: [label.name] };
    case 'documentType':
      return { documentTypes: [label.name] };
    case 'tag':
      return { tags: [label.name] };
  }
}

/** Tags under their parents, depth first; other kinds as they are. */
export function tree(labels: readonly Label[]): { label: Label; depth: number }[] {
  const ids = new Set(labels.map((label) => label.id));
  const out: { label: Label; depth: number }[] = [];
  const add = (parent: number | null, depth: number) => {
    for (const label of labels) {
      const top = label.parent === null || !ids.has(label.parent);
      if ((parent === null ? top : label.parent === parent) && depth < 10) {
        out.push({ label, depth });
        add(label.id, depth + 1);
      }
    }
  };
  add(null, 0);
  return out;
}

/** Whether `id` sits somewhere inside `ancestor`. */
function within(labels: readonly Label[], id: number, ancestor: number): boolean {
  let at = labels.find((label) => label.id === id)?.parent ?? null;
  for (let steps = 0; at !== null && steps < 10; steps++) {
    if (at === ancestor) return true;
    at = labels.find((label) => label.id === at)?.parent ?? null;
  }
  return false;
}

/** "home / insurance / car". */
function path(labels: readonly Label[], label: Label): string {
  const names = [label.name];
  let at = label.parent;
  for (let steps = 0; at !== null && steps < 10; steps++) {
    const parent = labels.find((l) => l.id === at);
    if (parent === undefined) break;
    names.unshift(parent.name);
    at = parent.parent;
  }
  return names.join(' / ');
}
