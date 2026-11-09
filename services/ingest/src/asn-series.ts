import type { SqlDriver } from '@sheaf/store';
import {
  ASN_SERIES_SIZE,
  MAX_ASN_SERIES,
  type AsnSeries,
  type AsnSeriesBody,
} from '@sheaf/protocol';

export type AsnSeriesRefusal = 'taken' | 'full' | 'in_use';

/**
 * Serial number series. Each takes the lowest free block of `ASN_SERIES_SIZE`
 * numbers above the main series' own, skipping any block a document already has a
 * number in, so starting a series never gives an existing number a new meaning.
 */
export class AsnSeriesStore {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  async list(): Promise<readonly AsnSeries[]> {
    return this.#driver.all<AsnSeries>('SELECT prefix, name, first FROM asn_series ORDER BY first');
  }

  async create(body: AsnSeriesBody): Promise<AsnSeries | AsnSeriesRefusal> {
    return this.#driver.transaction(async () => {
      const taken = await this.#driver.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM asn_series WHERE prefix = ?',
        [body.prefix],
      );
      if ((taken[0]?.n ?? 0) > 0) return 'taken';
      const used = new Set(
        (await this.#driver.all<{ first: number }>('SELECT first FROM asn_series')).map(
          (row) => row.first / ASN_SERIES_SIZE,
        ),
      );
      const numbered = await this.#driver.all<{ block: number }>(
        'SELECT DISTINCT CAST(asn / ? AS INTEGER) AS block FROM documents WHERE asn IS NOT NULL',
        [ASN_SERIES_SIZE],
      );
      for (const row of numbered) used.add(row.block);
      for (let block = 1; block <= MAX_ASN_SERIES; block++) {
        if (used.has(block)) continue;
        const series: AsnSeries = {
          prefix: body.prefix,
          name: body.name.trim(),
          first: block * ASN_SERIES_SIZE,
        };
        await this.#driver.run('INSERT INTO asn_series (prefix, name, first) VALUES (?, ?, ?)', [
          series.prefix,
          series.name,
          series.first,
        ]);
        return series;
      }
      return 'full';
    });
  }

  /** Removes a series no document, trash included, has a number in. */
  async remove(prefix: string): Promise<boolean | 'in_use'> {
    return this.#driver.transaction(async () => {
      const rows = await this.#driver.all<{ first: number }>(
        'SELECT first FROM asn_series WHERE prefix = ?',
        [prefix],
      );
      const series = rows[0];
      if (series === undefined) return false;
      const holders = await this.#driver.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM documents WHERE asn >= ? AND asn < ?',
        [series.first, series.first + ASN_SERIES_SIZE],
      );
      if ((holders[0]?.n ?? 0) > 0) return 'in_use';
      await this.#driver.run('DELETE FROM asn_series WHERE prefix = ?', [prefix]);
      return true;
    });
  }
}
