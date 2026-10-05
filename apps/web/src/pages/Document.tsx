import { useEffect, useState } from 'react';
import type { DocumentRecord, FieldEntry, HistoryEvent } from '@sheaf/protocol';
import type { Api } from '../api';
import { money, shortSha, when } from '../format';

const LABELS: Readonly<Record<string, string>> = {
  title: 'Title',
  date: 'Date',
  correspondent: 'From',
  documentType: 'Type',
  total: 'Total',
  tags: 'Tags',
};

/** One document: the PDF, its details with who set each one, and its history here. */
export function Document({ api, sha256 }: { api: Api; sha256: string }) {
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [fields, setFields] = useState<readonly FieldEntry[]>([]);
  const [events, setEvents] = useState<readonly HistoryEvent[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    void (async () => {
      const [r, f, h, p] = await Promise.all([
        api.record(sha256),
        api.fields(sha256),
        api.history(sha256),
        api.pdf(sha256),
      ]);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setRecord(r.value);
      setTitle(r.value.title ?? r.value.suggestions?.title ?? '');
      if (f.ok) setFields(f.value.fields);
      if (h.ok) setEvents(h.value.events);
      if (p.ok) {
        url = p.value;
        setPdf(url);
      }
    })();
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [api, sha256]);

  const saveTitle = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await api.patch(sha256, { title: title.trim() === '' ? null : title.trim() });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRecord(result.value);
    setSaved(true);
    const [f, h] = await Promise.all([api.fields(sha256), api.history(sha256)]);
    if (f.ok) setFields(f.value.fields);
    if (h.ok) setEvents(h.value.events);
  };

  if (error !== null) return <p className="error">{error}</p>;
  if (record === null) return <p className="muted">Loading…</p>;

  return (
    <div className="document">
      <div className="pdf">
        {pdf === null ? (
          <p className="muted">
            {record.bytesReleased
              ? 'The file was released once a connector confirmed it.'
              : 'Loading…'}
          </p>
        ) : (
          <iframe title="The document" src={pdf} />
        )}
      </div>

      <div className="details">
        <h1>{record.title ?? `Scan ${shortSha(sha256)}`}</h1>
        <p className="muted">Received {when(record.receivedAt)}</p>

        <form className="inline" onSubmit={(event) => void saveTitle(event)}>
          <label htmlFor="title">Title</label>
          <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <button type="submit">Save</button>
          {saved ? <span className="badge ok">Saved</span> : null}
        </form>

        <h2>Details</h2>
        {fields.length === 0 ? (
          <p className="muted">Nothing read from this document yet.</p>
        ) : (
          <table className="fields">
            <tbody>
              {fields.map((field) => (
                <tr key={field.name}>
                  <th scope="row">{LABELS[field.name] ?? field.name}</th>
                  <td>{display(field)}</td>
                  <td>
                    {field.source === 'user' ? (
                      <span className="badge ok">you</span>
                    ) : (
                      <span className="badge neutral" title="How sure the machine was">
                        machine · {field.confidence.toFixed(2)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>History</h2>
        <ol className="timeline">
          {events.map((event, i) => (
            <li key={i}>
              <time>{when(event.at)}</time> {event.text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function display(field: FieldEntry): string {
  if (field.value === null) return '(cleared)';
  if (field.name === 'total') return money(field.value) ?? '—';
  if (Array.isArray(field.value)) return field.value.join(', ');
  return typeof field.value === 'string' || typeof field.value === 'number'
    ? String(field.value)
    : JSON.stringify(field.value);
}
