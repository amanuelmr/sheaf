import { useEffect, useState } from 'react';
import type { DocumentRecord, FieldEntry, HistoryEvent } from '@sheaf/protocol';
import type { Api } from '../api';
import { money, shortSha, when } from '../format';
import { href } from '../route';
import { INBOX_CHANGED } from './Inbox';
import { DocumentFields } from './DocumentFields';
import { DocumentDetails } from './DocumentDetails';
import { Notes } from './Notes';
import { Share } from './Share';
import { Pages } from './Pages';
import { Access } from './Access';
import { Similar } from './Similar';
import { Stamp } from './Stamp';

const LABELS: Readonly<Record<string, string>> = {
  title: 'Title',
  date: 'Date',
  correspondent: 'From',
  documentType: 'Type',
  total: 'Total',
  tags: 'Tags',
  asn: 'Serial number',
};

/** One document: the PDF, its details with who set each one, and its history here. */
export function Document({ api, sha256 }: { api: Api; sha256: string }) {
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [fields, setFields] = useState<readonly FieldEntry[]>([]);
  const [events, setEvents] = useState<readonly HistoryEvent[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const [confirmTrash, setConfirmTrash] = useState(false);

  const moveToTrash = async () => {
    const result = await api.trashDocument(sha256);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.dispatchEvent(new Event(INBOX_CHANGED));
    window.location.hash = href({ page: 'trash' });
  };

  const restore = async () => {
    const result = await api.restore([sha256]);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const r = await api.record(sha256);
    if (r.ok) setRecord(r.value);
    window.dispatchEvent(new Event(INBOX_CHANGED));
  };

  const saved = async (next: DocumentRecord) => {
    setRecord(next);
    window.dispatchEvent(new Event(INBOX_CHANGED));
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
          <>
            <iframe title="The document" src={pdf} />
            <p className="small">
              <button
                type="button"
                className="link"
                onClick={() =>
                  void api
                    .downloadSearchable(sha256, record.title ?? shortSha(sha256))
                    .then((r) => {
                      if (!r.ok) setError(r.message);
                    })
                }
              >
                Download with its text inside
              </button>
            </p>
          </>
        )}
      </div>

      <div className="details">
        <h1>{record.title ?? record.suggestions?.title ?? `Scan ${shortSha(sha256)}`}</h1>
        <p className="muted">
          {[
            record.created === null ? null : `Dated ${record.created}`,
            record.asn === null ? null : `ASN ${String(record.asn)}`,
            `Received ${when(record.receivedAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {record.trashedAt === undefined ? null : (
          <p className="card">
            In the trash since {when(record.trashedAt)}.{' '}
            <button type="button" className="secondary" onClick={() => void restore()}>
              Restore
            </button>
          </p>
        )}

        {record.trashedAt === undefined ? <Similar api={api} sha256={sha256} /> : null}

        <DocumentDetails api={api} record={record} onSaved={(next) => void saved(next)} />

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

        <DocumentFields
          api={api}
          sha256={sha256}
          onChange={() =>
            void api.history(sha256).then((h) => {
              if (h.ok) setEvents(h.value.events);
            })
          }
        />

        <Notes
          api={api}
          sha256={sha256}
          onChange={() =>
            void api.history(sha256).then((h) => {
              if (h.ok) setEvents(h.value.events);
            })
          }
        />

        {record.trashedAt === undefined && !record.bytesReleased ? (
          <>
            <Pages api={api} sha256={sha256} />
            <Stamp api={api} sha256={sha256} />
          </>
        ) : null}

        {record.trashedAt === undefined ? <Share api={api} sha256={sha256} /> : null}

        <Access api={api} sha256={sha256} />

        <h2>History</h2>
        <ol className="timeline">
          {events.map((event, i) => (
            <li key={i}>
              <time>{when(event.at)}</time> {event.text}
            </li>
          ))}
        </ol>

        {record.trashedAt !== undefined ? null : confirmTrash ? (
          <p className="actions">
            <button type="button" className="danger" onClick={() => void moveToTrash()}>
              Move to trash
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmTrash(false)}>
              Keep it
            </button>
          </p>
        ) : (
          <p>
            <button type="button" className="secondary" onClick={() => setConfirmTrash(true)}>
              Delete…
            </button>
          </p>
        )}
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
