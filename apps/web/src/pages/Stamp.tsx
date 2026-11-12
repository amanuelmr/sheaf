import { useState } from 'react';
import {
  MAX_STAMP_TEXT,
  STAMP_COLOURS,
  STAMP_POSITIONS,
  stampProblem,
  type StampBody,
  type StampColour,
  type StampPosition,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';
import { href } from '../route';

const POSITION_NAMES: Record<StampPosition, string> = {
  'top-right': mark('Top right'),
  'top-left': mark('Top left'),
  'bottom-right': mark('Bottom right'),
  'bottom-left': mark('Bottom left'),
};

const COLOUR_NAMES: Record<StampColour, string> = {
  red: mark('Red'),
  blue: mark('Blue'),
  green: mark('Green'),
  black: mark('Black'),
};

/** Marks the document PAID, RECEIVED or anything short; the unstamped file stays a version. */
export function Stamp({ api, sha256 }: { api: Api; sha256: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<Required<StampBody>>({
    text: t('Paid'),
    withDate: true,
    position: 'top-right',
    colour: 'red',
    pages: 'first',
  });
  const [error, setError] = useState<string | null>(null);
  const problem = stampProblem(body);

  const stamp = async () => {
    const result = await api.stamp(sha256, body);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.location.hash = href({ page: 'document', sha256: result.value.sha256 });
  };

  return (
    <section>
      <h2>{t('Stamp')}</h2>
      <p className="muted small">
        {t('Mark it the way a rubber stamp would. The unstamped file is kept as a version.')}{' '}
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? t('Close') : t('Stamp…')}
        </button>
      </p>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void stamp();
          }}
        >
          <div className="filter-row">
            <div>
              <label htmlFor="stamp-text">{t('Words')}</label>
              <input
                id="stamp-text"
                maxLength={MAX_STAMP_TEXT}
                value={body.text}
                onChange={(event) => setBody({ ...body, text: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="stamp-position">{t('Where')}</label>
              <select
                id="stamp-position"
                value={body.position}
                onChange={(event) =>
                  setBody({ ...body, position: event.target.value as StampPosition })
                }
              >
                {STAMP_POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(POSITION_NAMES[p])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="stamp-colour">{t('Ink')}</label>
              <select
                id="stamp-colour"
                value={body.colour}
                onChange={(event) =>
                  setBody({ ...body, colour: event.target.value as StampColour })
                }
              >
                {STAMP_COLOURS.map((c) => (
                  <option key={c} value={c}>
                    {t(COLOUR_NAMES[c])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={body.withDate}
              onChange={(event) => setBody({ ...body, withDate: event.target.checked })}
            />{' '}
            {t('Add today’s date')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={body.pages === 'all'}
              onChange={(event) =>
                setBody({ ...body, pages: event.target.checked ? 'all' : 'first' })
              }
            />{' '}
            {t('Every page, not just the first')}
          </label>
          {problem === null ? null : <p className="error">{problem}</p>}
          {error === null ? null : <p className="error">{error}</p>}
          <p className="actions">
            <button type="submit" disabled={problem !== null}>
              {t('Stamp it')}
            </button>
          </p>
        </form>
      ) : null}
    </section>
  );
}
