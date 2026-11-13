import type { Failure } from './errors';
import { t } from './i18n';

/** What went wrong: a sentence of the app's own, or a failure from the server. */
export type Problem = string | Failure;

/** A message that says how something went, good or bad. */
export interface Notice {
  readonly ok: boolean;
  readonly text: Problem;
}

/**
 * Where a page says how something went. Both regions stay in the page while it is
 * shown, so a screen reader announces what appears in them: an error at once, a
 * success when it next pauses. A failure's own words sit behind "Technical details".
 */
export function Status({
  error = null,
  ok = null,
  notice,
  inline = false,
}: {
  error?: Problem | null;
  ok?: string | null;
  /** Either kind, from a page that keeps one message for both. */
  notice?: Notice | null;
  /** Beside a button rather than on a line of its own. */
  inline?: boolean;
}) {
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
              <details className="technical">
                <summary>{t('Technical details')}</summary>
                <code>{problem.detail}</code>
              </details>
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

export function textOf(problem: Problem): string {
  return typeof problem === 'string' ? problem : problem.message;
}
