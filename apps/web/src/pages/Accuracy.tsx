import { useEffect, useState } from 'react';
import type { AccuracyResponse, FieldAccuracy } from '@sheaf/protocol';
import type { Api } from '../api';
import { mark, t } from '../i18n';

const NAMES: Record<FieldAccuracy['field'], string> = {
  title: mark('title'),
  date: mark('date'),
  correspondent: mark('correspondent'),
  documentType: mark('type'),
  tags: mark('tags'),
};

/** Fewer judgements than this, and a share would say more about luck than the machine. */
const ENOUGH = 5;

/**
 * How far to trust each suggestion, from what people kept: "date: 91% of the last
 * 50". A field with too few judgements yet is left out rather than guessed at.
 */
export function Accuracy({ api }: { api: Api }) {
  const [accuracy, setAccuracy] = useState<AccuracyResponse | null>(null);

  useEffect(() => {
    void api.accuracy().then((result) => {
      if (result.ok) setAccuracy(result.value);
    });
  }, [api]);

  const shown = accuracy?.fields.filter((f) => f.judged >= ENOUGH) ?? [];
  if (shown.length === 0) return null;
  return (
    <p className="muted small accuracy">
      {t('How often suggestions were right:')}{' '}
      {shown.map((f, i) => (
        <span
          key={f.field}
          title={t('{right} of the last {judged} kept as suggested', {
            right: f.right,
            judged: f.judged,
          })}
        >
          {i === 0 ? '' : ' · '}
          {t('{field} {percent}% of {judged}', {
            field: t(NAMES[f.field]),
            percent: Math.round((f.right / f.judged) * 100),
            judged: f.judged,
          })}
        </span>
      ))}
    </p>
  );
}
