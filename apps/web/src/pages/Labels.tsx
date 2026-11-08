import { useCallback, useEffect, useState } from 'react';
import { LABEL_KINDS, type Label, type LabelKind } from '@sheaf/protocol';
import type { Api } from '../api';

const KIND_NAMES: Readonly<Record<LabelKind, { plural: string; one: string }>> = {
  tag: { plural: 'Tags', one: 'tag' },
  correspondent: { plural: 'Correspondents', one: 'correspondent' },
  documentType: { plural: 'Document types', one: 'document type' },
};

/** What one row is in the middle of, if anything. */
type Editing =
  | { readonly id: number; readonly mode: 'rename'; readonly text: string }
  | { readonly id: number; readonly mode: 'merge'; readonly into: number | null }
  | { readonly id: number; readonly mode: 'delete' };

/** Tags, correspondents and document types: add, rename, colour, merge and delete. */
export function Labels({ api }: { api: Api }) {
  const [kind, setKind] = useState<LabelKind>('tag');
  const [labels, setLabels] = useState<readonly Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState('');

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
      setError(result.message ?? 'That did not work.');
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

  const { plural, one } = KIND_NAMES[kind];

  return (
    <div>
      <h1>Labels</h1>
      <p className="subtitle">
        The names documents are filed under. Renaming or merging one changes every document that
        carries it.
      </p>
      <div className="tabs" role="group" aria-label="Kind of label">
        {LABEL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="secondary"
            aria-pressed={k === kind}
            onClick={() => setKind(k)}
          >
            {KIND_NAMES[k].plural}
          </button>
        ))}
      </div>
      {error === null ? null : <p className="error">{error}</p>}

      {labels === null ? <p className="muted">Loading…</p> : null}
      {labels !== null && labels.length === 0 ? (
        <p className="muted">No {plural.toLowerCase()} yet.</p>
      ) : null}
      <ul className="list">
        {(labels ?? []).map((label) => (
          <li key={label.id} id={`label-${String(label.id)}`}>
            {editing?.id === label.id && editing.mode === 'rename' ? (
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void apply(api.updateLabel(kind, label.id, { name: editing.text.trim() }));
                }}
              >
                <input
                  aria-label={`New name for ${label.name}`}
                  // Opened by the Rename button, so typing should go straight in.
                  autoFocus
                  value={editing.text}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                />
                <button type="submit" disabled={editing.text.trim() === ''}>
                  Rename
                </button>
                <button type="button" className="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <div>
                <strong>
                  {label.colour === null ? null : (
                    <span className="swatch" style={{ background: label.colour }} aria-hidden />
                  )}
                  {label.name}
                </strong>
                <span className="muted">
                  on {String(label.documents)} document{label.documents === 1 ? '' : 's'}
                </span>
              </div>
            )}
            <Actions
              label={label}
              others={(labels ?? []).filter((other) => other.id !== label.id)}
              editing={editing?.id === label.id ? editing : null}
              setEditing={setEditing}
              one={one}
              onColour={(colour) => void apply(api.updateLabel(kind, label.id, { colour }))}
              onMerge={(into) => void apply(api.mergeLabel(kind, label.id, into))}
              onDelete={() => void apply(api.deleteLabel(kind, label.id))}
            />
          </li>
        ))}
      </ul>

      <h2>New {one}</h2>
      <form className="card" onSubmit={(event) => void create(event)}>
        <label htmlFor="label-name">Name</label>
        <input id="label-name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" disabled={name.trim() === ''}>
          Add {one}
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
  one,
  onColour,
  onMerge,
  onDelete,
}: {
  label: Label;
  others: readonly Label[];
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  one: string;
  onColour: (colour: string | null) => void;
  onMerge: (into: number) => void;
  onDelete: () => void;
}) {
  if (editing?.mode === 'rename') return null;
  if (editing?.mode === 'delete') {
    return (
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          Remove from {String(label.documents)} document{label.documents === 1 ? '' : 's'}
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>
          Keep it
        </button>
      </div>
    );
  }
  if (editing?.mode === 'merge') {
    return (
      <div className="actions">
        <select
          aria-label={`Merge ${label.name} into`}
          value={editing.into ?? ''}
          onChange={(event) =>
            setEditing({
              ...editing,
              into: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        >
          <option value="">Merge into…</option>
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
          Merge
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>
          Cancel
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
              No colour
            </button>
          )}
        </>
      ) : null}
      <button
        type="button"
        className="secondary"
        onClick={() => setEditing({ id: label.id, mode: 'rename', text: label.name })}
      >
        Rename
      </button>
      {others.length === 0 ? null : (
        <button
          type="button"
          className="secondary"
          onClick={() => setEditing({ id: label.id, mode: 'merge', into: null })}
        >
          Merge…
        </button>
      )}
      <button
        type="button"
        className="secondary"
        aria-label={`Delete ${one} ${label.name}`}
        onClick={() => setEditing({ id: label.id, mode: 'delete' })}
      >
        Delete…
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
      aria-label={`Colour of ${label.name}`}
      value={colour}
      onChange={(event) => setColour(event.target.value)}
      onBlur={() => {
        if (colour !== (label.colour ?? '#888888')) onColour(colour);
      }}
    />
  );
}
