import { useEffect, useState } from 'react';
import type { Failure } from './errors';
import { t } from './i18n';

/** What went wrong: a sentence of the app's own, or a failure from the server. */
export type Problem = string | Failure;

/** A message that says how something went, good or bad. */
export interface Notice {
  readonly ok: boolean;
  readonly text: Problem;
}

interface Props {
  error?: Problem | null;
  ok?: string | null;
  /** Either kind, from a page that keeps one message for both. */
  notice?: Notice | null;
  /** Beside a button rather than on a line of its own. */
  inline?: boolean;
}

/**
 * Where a page says how something went. Both regions stay in the page while it is
 * shown, so a screen reader announces what appears in them: an error at once, a
 * success when it next pauses. A failure's own words sit behind "Technical details".
 *
 * A screen reader only announces what changes in a region it already knows, so a
 * message there from the start, as on a card that failed to load, waits until the
 * empty regions are in the page.
 */
export function Status(props: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Regions {...props} /> : <Regions inline={props.inline ?? false} />;
}

/** The regions and what is in them, all of it allowed inside a paragraph. */
export function Regions({ error = null, ok = null, notice, inline = false }: Props) {
  const problem = notice?.ok === false ? notice.text : error;
  const success = notice?.ok === true ? textOf(notice.text) : ok;
  const kind = inline ? 'status' : 'status block';
  return (
    <>
      <span className={kind} role="alert">
        {problem === null ? null : (
          <>
            <span className="error">{textOf(problem)}</span>
            {typeof problem === 'string' || problem.detail === undefined ? null : (
              <Technical detail={problem.detail} />
            )}
          </>
        )}
      </span>
      <span className={kind} role="status">
        {success === null ? null : <span className="badge ok">{success}</span>}
      </span>
    </>
  );
}

/** A button rather than `<details>`, which a paragraph may not hold. */
function Technical({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="technical">
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {t('Technical details')}
      </button>
      {open ? <code>{detail}</code> : null}
    </span>
  );
}

export function textOf(problem: Problem): string {
  return typeof problem === 'string' ? problem : problem.message;
}
