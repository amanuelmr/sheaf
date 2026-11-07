import { useEffect, useState } from 'react';
import { MAX_NOTE_LENGTH, type Note } from '@sheaf/protocol';
import type { Api } from '../api';
import { when } from '../format';

/** A document's notes: read them, add one, delete one. */
export function Notes({
  api,
  sha256,
  onChange,
}: {
  api: Api;
  sha256: string;
  /** Called after a note is added or deleted, so the page can refresh its history. */
  onChange: () => void;
}) {
  const [notes, setNotes] = useState<readonly Note[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const result = await api.notes(sha256);
      if (!current) return;
      if (result.ok) setNotes(result.value.notes);
      else setError(result.message);
    })();
    return () => {
      current = false;
    };
  }, [api, sha256]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.trim() === '') return;
    const result = await api.addNote(sha256, draft);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotes((current) => [...current, result.value]);
    setDraft('');
    setError(null);
    onChange();
  };

  const remove = async (id: number) => {
    const result = await api.deleteNote(sha256, id);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotes((current) => current.filter((note) => note.id !== id));
    onChange();
  };

  return (
    <section>
      <h2>Notes</h2>
      {notes.length === 0 ? <p className="muted">No notes yet.</p> : null}
      <ul className="notes">
        {notes.map((note) => (
          <li key={note.id} id={`note-${String(note.id)}`}>
            <p>{note.text}</p>
            <p className="muted small">
              {when(note.createdAt)}
              {note.author === null ? '' : ` · ${note.author}`}{' '}
              <button
                type="button"
                className="link"
                onClick={() => void remove(note.id)}
                aria-label={`Delete note from ${when(note.createdAt)}`}
              >
                Delete
              </button>
            </p>
          </li>
        ))}
      </ul>
      <form className="note-form" onSubmit={(event) => void add(event)}>
        <label htmlFor="new-note">Add a note</label>
        <textarea
          id="new-note"
          rows={2}
          maxLength={MAX_NOTE_LENGTH}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={draft.trim() === ''}>
          Add note
        </button>
      </form>
      {error === null ? null : <p className="error">{error}</p>}
    </section>
  );
}
