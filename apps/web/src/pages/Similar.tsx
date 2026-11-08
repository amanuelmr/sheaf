import { useEffect, useState } from 'react';
import type { SimilarDocument } from '@sheaf/protocol';
import type { Api } from '../api';
import { shortSha, when } from '../format';
import { href } from '../route';

/**
 * Says so when other documents say much the same: most often the same paper
 * scanned twice. Nothing happens to either until a person decides.
 */
export function Similar({ api, sha256 }: { api: Api; sha256: string }) {
  const [similar, setSimilar] = useState<readonly SimilarDocument[]>([]);

  useEffect(() => {
    void api.similar(sha256).then((result) => {
      setSimilar(result.ok ? result.value.documents : []);
    });
  }, [api, sha256]);

  if (similar.length === 0) return null;
  return (
    <div className="notice">
      <strong>
        {similar.length === 1
          ? 'This looks like the same paper as another document'
          : 'This looks like the same paper as other documents'}
      </strong>
      <ul>
        {similar.map((doc) => (
          <li key={doc.sha256}>
            <a href={href({ page: 'document', sha256: doc.sha256 })}>
              {doc.title ?? `Scan ${shortSha(doc.sha256)}`}
            </a>{' '}
            <span className="muted">
              {String(Math.round(doc.similarity * 100))}% alike · {when(doc.receivedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
