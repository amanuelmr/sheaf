import { useEffect, useState } from 'react';
import type { ShareLink } from '@sheaf/protocol';
import type { Api } from '../api';
import { when } from '../format';

const EXPIRY: readonly { days: number | null; text: string }[] = [
  { days: 7, text: 'for a week' },
  { days: 30, text: 'for a month' },
  { days: 1, text: 'for a day' },
  { days: null, text: 'until I revoke it' },
];

/** Links that open this document for anyone who has them. */
export function Share({ api, sha256 }: { api: Api; sha256: string }) {
  const [links, setLinks] = useState<readonly ShareLink[]>([]);
  const [days, setDays] = useState<number | null>(7);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    void api.shareLinks(sha256).then((result) => {
      if (current && result.ok) setLinks(result.value.links);
    });
    return () => {
      current = false;
    };
  }, [api, sha256]);

  const create = async () => {
    const result = await api.createShareLink(sha256, days);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setLinks((current) => [result.value, ...current]);
  };

  const revoke = async (id: number) => {
    const result = await api.revokeShareLink(id);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setLinks((current) => current.filter((link) => link.id !== id));
  };

  const copy = async (link: ShareLink) => {
    try {
      await navigator.clipboard.writeText(api.shareUrl(link.slug));
      setCopied(link.id);
    } catch {
      setError('Could not copy; select the link and copy it instead.');
    }
  };

  const now = Date.now();
  return (
    <section>
      <h2>Share</h2>
      <p className="muted small">Anyone with a link can open this document, without a token.</p>
      <ul className="links share-links">
        {links.map((link) => {
          const expired = link.expiresAt !== null && link.expiresAt <= now;
          return (
            <li key={link.id}>
              <input
                readOnly
                aria-label="Share link"
                value={api.shareUrl(link.slug)}
                onFocus={(event) => event.target.select()}
              />
              <span className="muted small">
                {expired
                  ? 'Expired'
                  : link.expiresAt === null
                    ? 'Until revoked'
                    : `Until ${when(link.expiresAt)}`}
              </span>
              <button type="button" className="secondary" onClick={() => void copy(link)}>
                {copied === link.id ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="link" onClick={() => void revoke(link.id)}>
                Revoke
              </button>
            </li>
          );
        })}
      </ul>
      <div className="asn-input">
        <select
          aria-label="How long the link works"
          value={days === null ? '' : String(days)}
          onChange={(event) =>
            setDays(event.target.value === '' ? null : Number(event.target.value))
          }
        >
          {EXPIRY.map((option) => (
            <option key={option.text} value={option.days === null ? '' : String(option.days)}>
              {option.text}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void create()}>
          Make a link
        </button>
      </div>
      {error === null ? null : <p className="error">{error}</p>}
    </section>
  );
}
