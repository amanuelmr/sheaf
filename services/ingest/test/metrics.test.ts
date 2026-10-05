import { describe as suite, expect, it } from 'vitest';
import { Registry, routeTemplate } from '../src/metrics';

suite('the metrics registry', () => {
  it('renders counters in Prometheus text format, label values escaped', () => {
    const registry = new Registry();
    const requests = registry.counter('sheaf_http_requests_total', 'Requests answered.', [
      'route',
      'status',
    ]);
    requests.inc({ route: '/v1/search', status: '200' });
    requests.inc({ route: '/v1/search', status: '200' }, 2);
    requests.inc({ route: 'odd "route"\n', status: '500' });
    expect(registry.render()).toBe(
      [
        '# HELP sheaf_http_requests_total Requests answered.',
        '# TYPE sheaf_http_requests_total counter',
        'sheaf_http_requests_total{route="/v1/search",status="200"} 3',
        'sheaf_http_requests_total{route="odd \\"route\\"\\n",status="500"} 1',
        '',
      ].join('\n'),
    );
  });

  it('renders histograms with cumulative buckets, a sum and a count', () => {
    const registry = new Registry();
    const latency = registry.histogram(
      'sheaf_http_request_duration_seconds',
      'Latency.',
      ['route'],
      [0.01, 0.1, 1],
    );
    latency.observe({ route: '/v1/health' }, 0.005);
    latency.observe({ route: '/v1/health' }, 0.05);
    latency.observe({ route: '/v1/health' }, 5);
    const text = registry.render();
    expect(text).toContain(
      'sheaf_http_request_duration_seconds_bucket{route="/v1/health",le="0.01"} 1',
    );
    expect(text).toContain(
      'sheaf_http_request_duration_seconds_bucket{route="/v1/health",le="0.1"} 2',
    );
    expect(text).toContain(
      'sheaf_http_request_duration_seconds_bucket{route="/v1/health",le="1"} 2',
    );
    expect(text).toContain(
      'sheaf_http_request_duration_seconds_bucket{route="/v1/health",le="+Inf"} 3',
    );
    expect(text).toContain('sheaf_http_request_duration_seconds_sum{route="/v1/health"} 5.055');
    expect(text).toContain('sheaf_http_request_duration_seconds_count{route="/v1/health"} 3');
  });

  it('replaces a gauge’s series wholesale each time it is set', () => {
    const registry = new Registry();
    const jobs = registry.gauge('sheaf_jobs', 'Jobs by state.', ['step', 'state']);
    jobs.set([{ labels: { step: 'ocr', state: 'pending' }, value: 4 }]);
    jobs.set([{ labels: { step: 'ocr', state: 'done' }, value: 9 }]);
    const text = registry.render();
    expect(text).toContain('sheaf_jobs{step="ocr",state="done"} 9');
    expect(text).not.toContain('pending');
  });

  it('refuses a metric registered twice', () => {
    const registry = new Registry();
    registry.counter('a_total', 'x', []);
    expect(() => registry.counter('a_total', 'x', [])).toThrow(/twice/);
  });
});

suite('route templates', () => {
  // Every document would otherwise be its own time series: unbounded cardinality.
  it.each([
    ['/v1/documents/' + 'a'.repeat(64), '/v1/documents/:sha256'],
    ['/v1/documents/' + 'a'.repeat(64) + '/text', '/v1/documents/:sha256/text'],
    ['/v1/archive/4821', '/v1/archive/:id'],
    ['/v1/archive/4821/thumbnail', '/v1/archive/:id/thumbnail'],
    ['/v1/devices/' + 'f'.repeat(32), '/v1/devices/:id'],
    ['/v1/search', '/v1/search'],
    ['/metrics', '/metrics'],
    ['/../../etc/passwd', 'other'],
    ['/v1/' + 'x'.repeat(500), 'other'],
  ])('reports %s as %s', (path, template) => {
    expect(routeTemplate(path)).toBe(template);
  });
});
