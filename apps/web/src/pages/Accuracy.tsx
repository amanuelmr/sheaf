import { useEffect, useState } from 'react';
import type { AccuracyResponse, FieldAccuracy } from '@sheaf/protocol';
import type { Api } from '../api';

const NAMES: Record<FieldAccuracy['field'], string> = {
  title: 'title',
  date: 'date',
  correspondent: 'correspondent',
  documentType: 'type',
  tags: 'tags',
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
      How often suggestions were right:{' '}
      {shown.map((f, i) => (
        <span
          key={f.field}
          title={`${String(f.right)} of the last ${String(f.judged)} kept as suggested`}
        >
          {i === 0 ? '' : ' · '}
          {NAMES[f.field]} {String(Math.round((f.right / f.judged) * 100))}% of {String(f.judged)}
        </span>
      ))}
    </p>
  );
}
