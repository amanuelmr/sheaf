import type { SqlDriver } from '@sheaf/store';
import { Registry, routeTemplate } from './metrics.ts';

/**
 * What the server reports at `/metrics`. Request counts and latencies are counted as
 * they happen; everything about stored state is read fresh from the database at
 * each scrape, so the numbers can never drift from the truth.
 */
export class ServerMetrics {
  readonly registry = new Registry();
  readonly #driver: SqlDriver;

  readonly #requests = this.registry.counter(
    'sheaf_http_requests_total',
    'Requests answered, by route template and status.',
    ['method', 'route', 'status'],
  );
  readonly #latency = this.registry.histogram(
    'sheaf_http_request_duration_seconds',
    'Time to answer a request.',
    ['route'],
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  );
  readonly #documents = this.registry.gauge('sheaf_documents', 'Documents stored.', []);
  readonly #jobs = this.registry.gauge('sheaf_jobs', 'Post-upload jobs by step and state.', [
    'step',
    'state',
  ]);
  readonly #deliveries = this.registry.gauge(
    'sheaf_deliveries',
    'Deliveries by connector and state; never-sent documents are not counted.',
    ['connector', 'state'],
  );
  readonly #oldestPending = this.registry.gauge(
    'sheaf_connector_oldest_pending_seconds',
    'Age of the oldest document a connector has yet to confirm.',
    ['connector'],
  );
  readonly #extractionCost = this.registry.gauge(
    'sheaf_extraction_cost_usd_total',
    'What extraction has cost, by provider; models without a known price are left out.',
    ['provider'],
  );
  readonly #extractionLatency = this.registry.gauge(
    'sheaf_extraction_latency_ms_avg',
    'Average time an extraction took, by provider.',
    ['provider'],
  );
  readonly #devices = this.registry.gauge(
    'sheaf_devices',
    'Paired phones, by whether still allowed.',
    ['state'],
  );

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  observeRequest(method: string, path: string, status: number, seconds: number): void {
    const route = routeTemplate(path);
    this.#requests.inc({ method, route, status: String(status) });
    this.#latency.observe({ route }, seconds);
  }

  async render(now: number): Promise<string> {
    const all = <T>(sql: string, params: (string | number)[] = []) =>
      this.#driver.all<T>(sql, params);

    const [documents] = await all<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
    this.#documents.set([{ labels: {}, value: documents?.n ?? 0 }]);

    const jobs = await all<{ step: string; state: string; n: number }>(
      'SELECT step, state, COUNT(*) AS n FROM jobs GROUP BY step, state',
    );
    this.#jobs.set(jobs.map((r) => ({ labels: { step: r.step, state: r.state }, value: r.n })));

    const deliveries = await all<{ connector: string; state: string; n: number }>(
      'SELECT connector, state, COUNT(*) AS n FROM deliveries GROUP BY connector, state',
    );
    this.#deliveries.set(
      deliveries.map((r) => ({ labels: { connector: r.connector, state: r.state }, value: r.n })),
    );

    const pending = await all<{ connector: string; oldest: number }>(
      `SELECT v.connector, MIN(d.received_at) AS oldest
         FROM deliveries v JOIN documents d ON d.sha256 = v.sha256
        WHERE v.state IN ('pending', 'sent') GROUP BY v.connector`,
    );
    this.#oldestPending.set(
      pending.map((r) => ({
        labels: { connector: r.connector },
        value: Math.max(0, (now - r.oldest) / 1000),
      })),
    );

    const extraction = await all<{ provider: string; cost: number | null; latency: number }>(
      'SELECT provider, SUM(cost_usd) AS cost, AVG(latency_ms) AS latency FROM extractions GROUP BY provider',
    );
    this.#extractionCost.set(
      extraction
        .filter((r) => r.cost !== null)
        .map((r) => ({ labels: { provider: r.provider }, value: r.cost! })),
    );
    this.#extractionLatency.set(
      extraction.map((r) => ({ labels: { provider: r.provider }, value: r.latency })),
    );

    const devices = await all<{ revoked: number; n: number }>(
      'SELECT revoked_at IS NOT NULL AS revoked, COUNT(*) AS n FROM devices GROUP BY 1',
    );
    this.#devices.set(
      devices.map((r) => ({
        labels: { state: r.revoked === 1 ? 'revoked' : 'active' },
        value: r.n,
      })),
    );

    return this.registry.render();
  }
}
