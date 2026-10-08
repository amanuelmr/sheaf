/**
 * Prometheus metrics, without a dependency: a counter, a gauge, a histogram, and the
 * text exposition format, which is all a scrape needs.
 *
 * Labels must stay low-cardinality. A document's hash as a label would make every
 * document its own time series and grow Prometheus without bound, which is why
 * request paths go through `routeTemplate` first.
 */
type Labels = Readonly<Record<string, string>>;

interface Metric {
  render(): string[];
}

export class Registry {
  readonly #metrics = new Map<string, Metric>();

  counter(name: string, help: string, labelNames: readonly string[]): Counter {
    return this.#add(name, new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[]): Gauge {
    return this.#add(name, new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram {
    return this.#add(name, new Histogram(name, help, labelNames, buckets));
  }

  /** Prometheus text format 0.0.4. */
  render(): string {
    return [...this.#metrics.values()].flatMap((metric) => metric.render()).join('\n') + '\n';
  }

  #add<T extends Metric>(name: string, metric: T): T {
    if (this.#metrics.has(name)) throw new Error(`metric ${name} registered twice`);
    this.#metrics.set(name, metric);
    return metric;
  }
}

export class Counter implements Metric {
  readonly #values = new Map<string, number>();
  readonly #name: string;
  readonly #help: string;
  readonly #labelNames: readonly string[];

  constructor(name: string, help: string, labelNames: readonly string[]) {
    this.#name = name;
    this.#help = help;
    this.#labelNames = labelNames;
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = series(this.#labelNames, labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + by);
  }

  render(): string[] {
    return [
      `# HELP ${this.#name} ${this.#help}`,
      `# TYPE ${this.#name} counter`,
      ...[...this.#values].map(([key, value]) => `${this.#name}${key} ${num(value)}`),
    ];
  }
}

/** Set from a fresh reading at scrape time; series not in the reading disappear. */
export class Gauge implements Metric {
  #values: readonly { key: string; value: number }[] = [];
  readonly #name: string;
  readonly #help: string;
  readonly #labelNames: readonly string[];

  constructor(name: string, help: string, labelNames: readonly string[]) {
    this.#name = name;
    this.#help = help;
    this.#labelNames = labelNames;
  }

  set(reading: readonly { labels: Labels; value: number }[]): void {
    this.#values = reading.map(({ labels, value }) => ({
      key: series(this.#labelNames, labels),
      value,
    }));
  }

  render(): string[] {
    return [
      `# HELP ${this.#name} ${this.#help}`,
      `# TYPE ${this.#name} gauge`,
      ...this.#values.map(({ key, value }) => `${this.#name}${key} ${num(value)}`),
    ];
  }
}

export class Histogram implements Metric {
  readonly #series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  readonly #name: string;
  readonly #help: string;
  readonly #labelNames: readonly string[];
  readonly #buckets: readonly number[];

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    this.#name = name;
    this.#help = help;
    this.#labelNames = labelNames;
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = series(this.#labelNames, labels);
    let entry = this.#series.get(key);
    if (entry === undefined) {
      entry = { labels, counts: this.#buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, entry);
    }
    this.#buckets.forEach((bound, i) => {
      if (value <= bound) entry.counts[i]! += 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.#name} ${this.#help}`, `# TYPE ${this.#name} histogram`];
    for (const { labels, counts, sum, count } of this.#series.values()) {
      this.#buckets.forEach((bound, i) => {
        lines.push(
          `${this.#name}_bucket${series([...this.#labelNames, 'le'], { ...labels, le: num(bound) })} ${num(counts[i]!)}`,
        );
      });
      lines.push(
        `${this.#name}_bucket${series([...this.#labelNames, 'le'], { ...labels, le: '+Inf' })} ${num(count)}`,
      );
      lines.push(`${this.#name}_sum${series(this.#labelNames, labels)} ${num(sum)}`);
      lines.push(`${this.#name}_count${series(this.#labelNames, labels)} ${num(count)}`);
    }
    return lines;
  }
}

function series(names: readonly string[], labels: Labels): string {
  if (names.length === 0) return '';
  const pairs = names.map((name) => `${name}="${escape(labels[name] ?? '')}"`);
  return `{${pairs.join(',')}}`;
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Numbers as Prometheus writes them: no trailing float noise. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e9) / 1e9);
}

const TEMPLATES: readonly (readonly [RegExp, string])[] = [
  [
    /^\/v1\/documents\/[0-9a-f]{64}(\/(text|suggestions|record|fields|history))?$/,
    '/v1/documents/:sha256$1',
  ],
  [/^\/v1\/archive\/[0-9]+(\/thumbnail)?$/, '/v1/archive/:id$1'],
  [/^\/v1\/devices\/[^/]+$/, '/v1/devices/:id'],
  [
    /^(\/v1\/(health|documents|search|inbox|archive|archive\/vocabulary|pair|pairing-codes|devices)|\/metrics)$/,
    '$1',
  ],
];

/**
 * A request path as the route it matched, with ids taken out. Anything that matches
 * no route is `other`, so a scanner probing random paths cannot add series either.
 */
export function routeTemplate(path: string): string {
  for (const [pattern, template] of TEMPLATES) {
    if (pattern.test(path)) return path.replace(pattern, template);
  }
  return 'other';
}
