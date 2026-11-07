import { useEffect, useState } from 'react';
import type { AccessLevel, DocumentPermissions, Me } from '@sheaf/protocol';
import type { Api } from '../api';

/** Who a document belongs to and whom it is shared with. Hidden while there are no users. */
export function Access({ api, sha256 }: { api: Api; sha256: string }) {
  const [permissions, setPermissions] = useState<DocumentPermissions | null>(null);
  const [draft, setDraft] = useState<DocumentPermissions | null>(null);
  const [people, setPeople] = useState<readonly { id: number; username: string }[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [adding, setAdding] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([api.permissions(sha256), api.userDirectory(), api.me()]).then(
      ([perms, directory, who]) => {
        if (!current) return;
        if (perms.ok) {
          setPermissions(perms.value);
          setDraft(perms.value);
        }
        if (directory.ok) setPeople(directory.value.users);
        if (who.ok) setMe(who.value);
      },
    );
    return () => {
      current = false;
    };
  }, [api, sha256]);

  if (permissions === null || draft === null || people.length === 0) return null;
  const name = (id: number) => people.find((p) => p.id === id)?.username ?? `user ${String(id)}`;
  const canDecide = me?.role === 'admin' || (me?.id !== null && me?.id === permissions.owner);
  const changed = JSON.stringify(draft) !== JSON.stringify(permissions);

  const save = async () => {
    const result = await api.setPermissions(sha256, draft);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setPermissions(result.value);
    setDraft(result.value);
    setMessage({ ok: true, text: 'Saved' });
  };

  if (!canDecide) {
    return (
      <section>
        <h2>Who can see this</h2>
        <p className="muted small">
          {permissions.owner === null
            ? 'Everyone.'
            : `${name(permissions.owner)}'s, shared with ${String(permissions.grants.length)} other${permissions.grants.length === 1 ? '' : 's'}.`}
        </p>
      </section>
    );
  }

  const others = people.filter(
    (p) => p.id !== draft.owner && !draft.grants.some((grant) => grant.user === p.id),
  );
  return (
    <section>
      <h2>Who can see this</h2>
      <label htmlFor="access-owner">Belongs to</label>
      <select
        id="access-owner"
        value={draft.owner === null ? '' : String(draft.owner)}
        onChange={(event) => {
          const owner = event.target.value === '' ? null : Number(event.target.value);
          setDraft({ owner, grants: draft.grants.filter((grant) => grant.user !== owner) });
        }}
      >
        <option value="">Everyone: shared with all</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.username}
          </option>
        ))}
      </select>
      {draft.owner === null ? null : (
        <>
          <ul className="links share-links">
            {draft.grants.map((grant) => (
              <li key={grant.user}>
                <span>{name(grant.user)}</span>
                <select
                  aria-label={`What ${name(grant.user)} may do`}
                  value={grant.level}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      grants: draft.grants.map((g) =>
                        g.user === grant.user
                          ? { ...g, level: event.target.value as AccessLevel }
                          : g,
                      ),
                    })
                  }
                >
                  <option value="view">Read</option>
                  <option value="change">Read and change</option>
                </select>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      grants: draft.grants.filter((g) => g.user !== grant.user),
                    })
                  }
                >
                  Stop sharing
                </button>
              </li>
            ))}
          </ul>
          {others.length === 0 ? null : (
            <span className="asn-input">
              <select
                aria-label="Share with"
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
              >
                <option value="">Share with…</option>
                {others.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.username}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary"
                disabled={adding === ''}
                onClick={() => {
                  setDraft({
                    ...draft,
                    grants: [...draft.grants, { user: Number(adding), level: 'view' }],
                  });
                  setAdding('');
                }}
              >
                Add
              </button>
            </span>
          )}
        </>
      )}
      <p className="actions">
        <button type="button" disabled={!changed} onClick={() => void save()}>
          Save
        </button>
        {message === null ? null : (
          <span className={message.ok ? 'badge ok' : 'error'}>{message.text}</span>
        )}
      </p>
    </section>
  );
}
