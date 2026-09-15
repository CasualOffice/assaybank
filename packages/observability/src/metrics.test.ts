/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Registry } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  counter,
  gauge,
  histogram,
  MetricCardinalityError,
  MetricNameError,
  metricsHandler,
  type MetricsHttpResponse,
  type MetricsRegistry,
  OTHER,
  UNKNOWN,
} from './metrics.js';

let registry: MetricsRegistry;

beforeEach(() => {
  registry = new Registry();
});

/**
 * Rule 2 of P0 step 4. Unbounded label cardinality kills a Prometheus instance, and it
 * fails at peak, because peak is when the unbounded thing has the most distinct values.
 */
describe('the cardinality gate (docs/12 §6)', () => {
  const forbidden = [
    'candidate_id',
    'attempt_id',
    'question_id',
    'user_id',
    'submission_id',
    'org_id',
  ] as const;

  it.each(forbidden)('refuses to build a counter labelled %s', (label) => {
    expect(() =>
      counter({
        name: 'exec_calls_total',
        help: 'Execution calls.',
        labelNames: [label],
        registry,
      }),
    ).toThrow(MetricCardinalityError);
  });

  it.each(forbidden)('refuses to build a gauge labelled %s', (label) => {
    expect(() =>
      gauge({ name: 'bullmq_queue_depth', help: 'Backlog.', labelNames: [label], registry }),
    ).toThrow(MetricCardinalityError);
  });

  it.each(forbidden)('refuses to build a histogram labelled %s', (label) => {
    expect(() =>
      histogram({
        name: 'exec_wall_time_seconds',
        help: 'Sandbox wall clock.',
        labelNames: [label],
        registry,
      }),
    ).toThrow(MetricCardinalityError);
  });

  it('refuses any *_id that is not on the small allow-list', () => {
    expect(() =>
      counter({
        name: 'webhook_delivery_total',
        help: 'Deliveries.',
        labelNames: ['endpoint_id'],
        registry,
      }),
    ).toThrow(/only permitted \*_id labels/u);
  });

  it('permits the operator-inventory ids that are drawn from a fixed list', () => {
    expect(() =>
      gauge({ name: 'exec_node_health', help: 'Node health.', labelNames: ['node_id'], registry }),
    ).not.toThrow();
  });

  it('refuses the other unbounded labels docs/12 §6 names', () => {
    for (const label of ['email', 'ip_address', 'user_agent', 'url', 'route', 'message']) {
      expect(
        () =>
          counter({
            name: 'http_requests_total',
            help: 'Requests.',
            labelNames: [label],
            registry: new Registry(),
          }),
        label,
      ).toThrow(MetricCardinalityError);
    }
  });

  it('accepts the closed-set labels the catalogue actually uses', () => {
    expect(() =>
      counter({
        name: 'http_requests_total',
        help: 'Requests.',
        labelNames: ['route_class', 'method', 'status_class'],
        registry,
      }),
    ).not.toThrow();
  });

  it('rejects a label name that is not lower_snake_case, and a duplicate', () => {
    expect(() =>
      counter({ name: 'mail_send_failure_total', help: 'x', labelNames: ['Template'], registry }),
    ).toThrow(MetricCardinalityError);

    expect(() =>
      counter({
        name: 'mail_send_failure_total',
        help: 'x',
        labelNames: ['template', 'template'],
        registry: new Registry(),
      }),
    ).toThrow(MetricCardinalityError);
  });
});

describe('metric naming conventions (docs/12 §4)', () => {
  it('requires a counter to end in _total', () => {
    expect(() => counter({ name: 'autosave_failure', help: 'x', registry })).toThrow(
      MetricNameError,
    );
  });

  it('requires a histogram to carry a base-unit suffix', () => {
    expect(() => histogram({ name: 'exec_wall_time', help: 'x', registry })).toThrow(
      MetricNameError,
    );
  });

  it('refuses milliseconds outright', () => {
    expect(() => histogram({ name: 'exec_wall_time_ms', help: 'x', registry })).toThrow(
      /base units/u,
    );
  });

  it('refuses a name that is not lower_snake_case', () => {
    expect(() => gauge({ name: 'ExecNodeHealth', help: 'x', registry })).toThrow(MetricNameError);
  });

  it('refuses to register the same name twice, which would silently split the series', () => {
    gauge({ name: 'collab_docs_resident', help: 'x', registry });
    expect(() => gauge({ name: 'collab_docs_resident', help: 'x', registry })).toThrow(
      MetricNameError,
    );
  });
});

describe('counter', () => {
  it('records against its declared labels', async () => {
    const calls = counter({
      name: 'exec_calls_total',
      help: 'Execution calls.',
      labelNames: ['language', 'outcome'],
      registry,
    });

    calls.inc({ language: 'python', outcome: 'ok' });
    calls.inc({ language: 'python', outcome: 'ok' }, 2);

    const exposition = await registry.metrics();
    expect(exposition).toContain('exec_calls_total{language="python",outcome="ok"} 3');
  });

  it('works without labels at all', async () => {
    const expired = counter({ name: 'deadline_sweep_expired_total', help: 'x', registry });
    expired.inc();
    expect(await registry.metrics()).toContain('deadline_sweep_expired_total 1');
  });
});

describe('closed label value sets', () => {
  it('folds a value outside the declared set to `other` instead of minting a series', async () => {
    const failures = counter({
      name: 'bullmq_job_failed_total',
      help: 'Jobs that threw.',
      labelNames: ['reason'],
      labelValues: { reason: ['exec_unavailable', 'timeout', 'db_error', 'validation', 'unknown'] },
      registry,
    });

    // The shape of the accident this prevents: an upstream message passed through as a
    // label, one new time series per distinct sandbox error string.
    failures.inc({ reason: 'connect ECONNREFUSED 10.2.0.7:2000' });
    failures.inc({ reason: 'connect ECONNREFUSED 10.2.0.8:2000' });
    failures.inc({ reason: 'timeout' });

    const exposition = await registry.metrics();
    expect(exposition).toContain(`bullmq_job_failed_total{reason="${OTHER}"} 2`);
    expect(exposition).toContain('bullmq_job_failed_total{reason="timeout"} 1');
    expect(exposition).not.toContain('ECONNREFUSED');
  });

  it('labels a missing value `unknown` rather than an empty string', async () => {
    const sent = counter({
      name: 'invitations_sent_total',
      help: 'x',
      labelNames: ['channel'],
      registry,
    });
    sent.inc();
    expect(await registry.metrics()).toContain(`invitations_sent_total{channel="${UNKNOWN}"} 1`);
  });

  it('ignores label keys that were never declared', async () => {
    const sent = counter({
      name: 'invitations_redeemed_total',
      help: 'x',
      labelNames: ['channel'],
      registry,
    });
    sent.inc({ channel: 'email', attempt_id: 'att_1' } as never);
    const exposition = await registry.metrics();
    expect(exposition).toContain('invitations_redeemed_total{channel="email"} 1');
    expect(exposition).not.toContain('att_1');
  });
});

describe('the per-metric series budget', () => {
  it('drops observations once a family exhausts its budget', async () => {
    const rateLimited = counter({
      name: 'http_rate_limited_total',
      help: 'x',
      labelNames: ['scope'],
      maxSeries: 2,
      registry,
    });

    rateLimited.inc({ scope: 'a' });
    rateLimited.inc({ scope: 'b' });
    rateLimited.inc({ scope: 'c' });
    rateLimited.inc({ scope: 'a' });

    const exposition = await registry.metrics();
    expect(exposition).toContain('http_rate_limited_total{scope="a"} 2');
    expect(exposition).toContain('http_rate_limited_total{scope="b"} 1');
    expect(exposition).not.toContain('scope="c"');
    expect(exposition).toContain('metric_series_dropped_total{metric="http_rate_limited_total"} 1');
  });

  it('never throws on the observation path, whatever the caller passes', () => {
    const depth = gauge({ name: 'bullmq_queue_depth', help: 'x', labelNames: ['queue'], registry });
    expect(() => depth.set({ queue: 'grading.submit' }, 12)).not.toThrow();
    expect(() => depth.set(3)).not.toThrow();
    expect(() => depth.inc()).not.toThrow();
    expect(() => depth.dec({ queue: 'grading.submit' }, 4)).not.toThrow();
  });
});

describe('gauge and histogram', () => {
  it('sets a gauge with and without labels', async () => {
    const depth = gauge({
      name: 'bullmq_dlq_depth',
      help: 'Jobs that exhausted retries.',
      labelNames: ['queue'],
      registry,
    });
    depth.set({ queue: 'grading.submit' }, 4);
    expect(await registry.metrics()).toContain('bullmq_dlq_depth{queue="grading.submit"} 4');
  });

  it('observes into the declared buckets', async () => {
    const wall = histogram({
      name: 'exec_wall_time_seconds',
      help: 'Sandbox wall clock per call.',
      labelNames: ['language'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 10],
      registry,
    });

    wall.observe({ language: 'python' }, 0.3);
    wall.observe({ language: 'python' }, 6);

    const exposition = await registry.metrics();
    expect(exposition).toContain('exec_wall_time_seconds_bucket{le="0.5",language="python"} 1');
    expect(exposition).toContain('exec_wall_time_seconds_count{language="python"} 2');
  });

  it('times a call with startTimer', async () => {
    const latency = histogram({
      name: 'autosave_latency_seconds',
      help: 'x',
      labelNames: ['kind'],
      registry,
    });
    const stop = latency.startTimer({ kind: 'code' });
    const elapsed = stop();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(await registry.metrics()).toContain('autosave_latency_seconds_count{kind="code"} 1');
  });
});

describe('metricsHandler', () => {
  function fakeResponse(): MetricsHttpResponse & { headers: Record<string, string>; body: string } {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name: string, value: string): void {
        this.headers[name] = value;
      },
      end(chunk?: string): void {
        this.body = chunk ?? '';
      },
    };
  }

  it('serves the exposition as Prometheus text', async () => {
    counter({ name: 'attempts_started_total', help: 'Arrival rate.', registry }).inc();

    const res = fakeResponse();
    metricsHandler(registry)({}, res);
    await vi.waitFor(() => expect(res.body).not.toBe(''));

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/plain');
    expect(res.body).toContain('attempts_started_total 1');
  });

  it('answers 500 rather than a partial exposition when the scrape fails', async () => {
    const broken = {
      contentType: 'text/plain',
      metrics: () => Promise.reject(new Error('registry unavailable')),
    } as unknown as MetricsRegistry;

    const res = fakeResponse();
    metricsHandler(broken)({}, res);
    await vi.waitFor(() => expect(res.statusCode).toBe(500));

    expect(res.body).toContain('# metrics unavailable');
  });
});
