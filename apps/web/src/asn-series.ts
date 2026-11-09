import { useEffect, useState } from 'react';
import type { AsnSeries } from '@sheaf/protocol';
import type { Api } from './api';

let cached: readonly AsnSeries[] | null = null;

/** Forget the series fetched, after one is started or removed. */
export function forgetAsnSeries(): void {
  cached = null;
}

/**
 * The serial number series, fetched once for every page that prints a number:
 * they change rarely, and a number printed without its series' prefix is the
 * wrong number.
 */
export function useAsnSeries(api: Api): readonly AsnSeries[] {
  const [series, setSeries] = useState<readonly AsnSeries[]>(cached ?? []);
  useEffect(() => {
    if (cached !== null) return;
    let live = true;
    void api.asnSeries().then((result) => {
      if (!result.ok) return;
      cached = result.value.series;
      if (live) setSeries(cached);
    });
    return () => {
      live = false;
    };
  }, [api]);
  return series;
}
