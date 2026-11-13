import { useEffect, useState } from 'react';
import { asnLabel, type DocumentRecord, type FieldEntry, type HistoryEvent } from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';
import { useAsnSeries } from '../asn-series';
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
import { Status, type Problem } from '../status';

const LABELS: Readonly<Record<string, string>> = {
  title: mark('Title'),
  date: mark('Date'),
  correspondent: mark('From'),
  otherCorrespondents: mark('Also from'),
  documentType: mark('Type'),
  total: mark('Total'),
  tags: mark('Tags'),
  asn: mark('Serial number'),
};

/** One document: the PDF, its details with who set each one, and its history here. */
export function Document({ api, sha256 }: { api: Api; sha256: string }) {
  const series = useAsnSeries(api);
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [fields, setFields] = useState<readonly FieldEntry[]>([]);
  const [events, setEvents] = useState<readonly HistoryEvent[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [pdfError, setPdfError] = useState<Problem | null>(null);

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
        setError(r);
        return;
      }
      setRecord(r.value);
      if (f.ok) setFields(f.value.fields);
      if (h.ok) setEvents(h.value.events);
      if (p.ok) {
        url = p.value;
        setPdf(url);
      } else if (!r.value.bytesReleased) {
        setPdfError(p);
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
      setError(result);
      return;
    }
    window.dispatchEvent(new Event(INBOX_CHANGED));
    window.location.hash = href({ page: 'trash' });
  };

  const restore = async () => {
    const result = await api.restore([sha256]);
    if (!result.ok) {
      setError(result);
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

  if (record === null)
    return (
      <>
        <Status error={error} />
        {error === null ? <p className="muted">Loading…</p> : null}
      </>
    );

  return (
    <div className="document">
      <div className="pdf">
        {pdf === null ? (
          <>
            <Status error={pdfError} />
            {pdfError === null ? (
              <p className="muted">
                {record.bytesReleased
                  ? t('The file was released once a connector confirmed it.')
                  : t('Loading…')}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <iframe title={t('The document')} src={pdf} />
            <p className="small">
              <button
                type="button"
                className="link"
                onClick={() =>
                  void api
                    .downloadSearchable(sha256, record.title ?? shortSha(sha256))
                    .then((r) => {
                      if (!r.ok) setError(r);
                    })
                }
              >
                {t('Download with its text inside')}
              </button>
            </p>
          </>
        )}
      </div>

      <div className="details">
        <h1>
          {record.title ?? record.suggestions?.title ?? t('Scan {id}', { id: shortSha(sha256) })}
        </h1>
        <p className="muted">
          {[
            record.created === null ? null : t('Dated {date}', { date: record.created }),
            record.asn === null ? null : `ASN ${asnLabel(record.asn, series)}`,
            t('Received {when}', { when: when(record.receivedAt) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {record.trashedAt === undefined ? null : (
          <p className="card">
            {t('In the trash since {when}.', { when: when(record.trashedAt) })}{' '}
            <button type="button" className="secondary" onClick={() => void restore()}>
              {t('Restore')}
            </button>
          </p>
        )}

        {record.trashedAt === undefined ? <Similar api={api} sha256={sha256} /> : null}

        <DocumentDetails api={api} record={record} onSaved={(next) => void saved(next)} />

        <h2>{t('Details')}</h2>
        {fields.length === 0 ? (
          <p className="muted">{t('Nothing read from this document yet.')}</p>
        ) : (
          <table className="fields">
            <tbody>
              {fields.map((field) => (
                <tr key={field.name}>
                  <th scope="row">{t(LABELS[field.name] ?? field.name)}</th>
                  <td>{display(field)}</td>
                  <td>
                    {field.source === 'user' ? (
                      <span className="badge ok">{t('you')}</span>
                    ) : (
                      <span className="badge neutral" title={t('How sure the machine was')}>
                        {t('machine')} · {field.confidence.toFixed(2)}
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

        <h2>{t('History')}</h2>
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
              {t('Move to trash')}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmTrash(false)}>
              {t('Keep it')}
            </button>
          </p>
        ) : (
          <p>
            <button type="button" className="secondary" onClick={() => setConfirmTrash(true)}>
              {t('Delete…')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function display(field: FieldEntry): string {
  if (field.value === null) return t('(cleared)');
  if (field.name === 'total') return money(field.value) ?? '—';
  if (Array.isArray(field.value)) return field.value.join(', ');
  return typeof field.value === 'string' || typeof field.value === 'number'
    ? String(field.value)
    : JSON.stringify(field.value);
}
