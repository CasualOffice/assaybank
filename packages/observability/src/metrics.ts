/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Prometheus registry and the bounded-cardinality metric helpers (docs/12 §4, §6).
 *
 * A Prometheus time series exists for every unique combination of label values, so one
 * unbounded label destroys the metrics tier — and it does so at peak, because peak is
 * when the unbounded thing has the most distinct values. That failure is much easier to
 * prevent in a wrapper than to find later, so the wrapper is the only way this codebase
 * creates a metric:
 *
 *  - A forbidden label name (`attempt_id`, `candidate_id`, `org_id`, anything ending in
 *    `_id` that is not on the small operator-inventory allow-list) throws at
 *    construction, which is boot time and therefore a failed deploy rather than an
 *    outage of the tool you diagnose outages with.
 *  - A label value outside its declared closed set is folded to `other` at observation
 *    time, and a series that would exceed the per-metric budget is dropped. Neither
 *    throws: telemetry is best-effort and must never fail a request or a job.
 *
 * High-cardinality identifiers belong on spans and logs. `attempt_id` on a span is
 * correct; `attempt_id` on a metric is an incident.
 */

import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
  Registry,
} from 'prom-client';

import { logger } from './logger.js';

/** The registry every service exposes on `/metrics`. */
export type MetricsRegistry = Registry;

/** The process-wide registry. Prometheus scrapes this directly as well as via the collector. */
export const metrics: MetricsRegistry = new Registry();

/** docs/12 §6: any single metric family is budgeted 2,000 series. */
export const DEFAULT_MAX_SERIES = 2000;

/** The bucket placeholder for a label value that was not in its declared closed set. */
export const OTHER = 'other';

/** The placeholder for a declared label the caller did not supply. */
export const UNKNOWN = 'unknown';

/**
 * Label names that are never acceptable, spelled out so the error message can say which
 * rule was broken. docs/12 §6 lists these explicitly; `org_id` is here because the
 * tenant count grows without limit *and* because per-tenant series leak the tenant list
 * to anyone who can read `/metrics`.
 */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set([
  'candidate_id',
  'attempt_id',
  'attempt_question_id',
  'question_id',
  'question_version_id',
  'submission_id',
  'submission_result_id',
  'session_id',
  'user_id',
  'invitation_id',
  'org_id',
  'organisation_id',
  'organization_id',
  'tenant',
  'tenant_id',
  'email',
  'name',
  'full_name',
  'candidate',
  'ip',
  'ip_address',
  'user_agent',
  'path',
  'url',
  'route',
  'sql',
  'statement',
  'query',
  'error',
  'message',
  'exception',
  'stack',
  'trace_id',
  'span_id',
  'request_id',
  'job_id',
  'endpoint',
  'host',
  'hostname',
  'pod',
  'container',
  'container_id',
  // Added at scrape time by infra/prometheus/prometheus.yml, never in application code.
  'tier',
]);

/**
 * The small allow-list of `*_id` labels. Each is an operator-assigned name drawn from a
 * fixed inventory — never a container id, a pod name or anything a scheduler invents.
 */
const ALLOWED_ID_LABELS: ReadonlySet<string> = new Set(['node_id', 'replica_id', 'shard_id']);

const METRIC_NAME_RE = /^[a-z][a-z0-9_]*$/u;
const LABEL_NAME_RE = /^[a-z][a-z0-9_]*$/u;

/** Histograms and gauges carry a base-unit suffix; `_ms` is never one (docs/12 §4). */
const UNIT_SUFFIXES: readonly string[] = ['_seconds', '_bytes', '_ratio'];

/**
 * Thrown at metric construction. It is a developer error, caught at boot, and it is
 * deliberately loud: the alternative is discovering the cardinality in production.
 */
export class MetricCardinalityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MetricCardinalityError';
  }
}

/** Thrown at metric construction when a name breaks the conventions in docs/12 §4. */
export class MetricNameError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MetricNameError';
  }
}

/** Label values are strings from a closed set; numbers are accepted and stringified. */
export type MetricLabels<L extends string> = Readonly<Record<L, string | number>>;

/** Common shape of every metric declaration. */
export interface MetricSpec<L extends string = never> {
  /** `lower_snake_case`, subsystem first, no vendor prefix. Renaming one breaks dashboards. */
  readonly name: string;
  /** The `# HELP` line. Written for the on-call engineer who has never seen this metric. */
  readonly help: string;
  /** The closed set of label names. Every one is validated against §6. */
  readonly labelNames?: readonly L[] | undefined;
  /**
   * The closed set of values per label, fixed in code (docs/12 §6: "if you cannot write
   * down every possible value, it is not a label"). A value outside the set becomes
   * `other` rather than a new series.
   */
  readonly labelValues?: { readonly [K in L]?: readonly string[] } | undefined;
  /** Per-metric series budget. Defaults to {@link DEFAULT_MAX_SERIES}. */
  readonly maxSeries?: number | undefined;
  /** Defaults to the shared {@link metrics} registry. */
  readonly registry?: MetricsRegistry | undefined;
}

/** A histogram declaration. Buckets are sized against the limit the metric measures. */
export interface HistogramSpec<L extends string = never> extends MetricSpec<L> {
  readonly buckets?: readonly number[] | undefined;
}

/** A counter: monotonic, named `*_total`. */
export interface CounterMetric<L extends string = never> {
  readonly name: string;
  inc(labels?: MetricLabels<L>, value?: number): void;
  reset(): void;
}

/** A gauge: a number that goes up and down. */
export interface GaugeMetric<L extends string = never> {
  readonly name: string;
  set(value: number): void;
  set(labels: MetricLabels<L>, value: number): void;
  inc(labels?: MetricLabels<L>, value?: number): void;
  dec(labels?: MetricLabels<L>, value?: number): void;
  setToCurrentTime(labels?: MetricLabels<L>): void;
  reset(): void;
}

/** A histogram: a distribution, in base units. */
export interface HistogramMetric<L extends string = never> {
  readonly name: string;
  observe(value: number): void;
  observe(labels: MetricLabels<L>, value: number): void;
  /** Starts a timer; the returned function records the elapsed seconds and returns them. */
  startTimer(labels?: MetricLabels<L>): () => number;
  reset(): void;
}

function assertMetricName(name: string, kind: 'counter' | 'gauge' | 'histogram'): void {
  if (!METRIC_NAME_RE.test(name)) {
    throw new MetricNameError(
      `metric name "${name}" must be lower_snake_case and start with a letter (docs/12 §4).`,
    );
  }
  if (name.endsWith('_ms')) {
    throw new MetricNameError(
      `metric name "${name}" uses milliseconds. Prometheus convention is base units: ` +
        'use _seconds, or the dashboard is wrong by a factor of 1000 exactly once, at ' +
        'the worst moment (docs/12 §4).',
    );
  }
  if (kind === 'counter' && !name.endsWith('_total')) {
    throw new MetricNameError(`counter "${name}" must end in _total (docs/12 §4).`);
  }
  if (kind === 'histogram' && !UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw new MetricNameError(
      `histogram "${name}" must carry a unit suffix (${UNIT_SUFFIXES.join(', ')}) (docs/12 §4).`,
    );
  }
}

/**
 * The cardinality gate. Runs once per metric, at construction.
 *
 * Exported for the fixture test that proves each forbidden name throws; application code
 * reaches it through {@link counter}, {@link gauge} and {@link histogram}.
 */
export function assertLabelNames(metricName: string, labelNames: readonly string[]): void {
  const seen = new Set<string>();

  for (const label of labelNames) {
    if (!LABEL_NAME_RE.test(label)) {
      throw new MetricCardinalityError(
        `label "${label}" on "${metricName}" must be lower_snake_case (docs/12 §4).`,
      );
    }
    if (seen.has(label)) {
      throw new MetricCardinalityError(`label "${label}" is declared twice on "${metricName}".`);
    }
    seen.add(label);

    if (FORBIDDEN_LABELS.has(label)) {
      throw new MetricCardinalityError(
        `label "${label}" is forbidden on "${metricName}": its value set is unbounded, and ` +
          'one unbounded label destroys the metrics tier at peak. Put it on the span and ' +
          'the log line instead, and label the metric with a closed set (docs/12 §6).',
      );
    }

    if (label.endsWith('_id') && !ALLOWED_ID_LABELS.has(label)) {
      throw new MetricCardinalityError(
        `label "${label}" is forbidden on "${metricName}": an identifier is unbounded. The ` +
          `only permitted *_id labels are ${[...ALLOWED_ID_LABELS].join(', ')}, which are ` +
          'operator-assigned names from a fixed inventory (docs/12 §6).',
      );
    }
  }

  if (labelNames.length > 6) {
    throw new MetricCardinalityError(
      `"${metricName}" declares ${String(labelNames.length)} labels. The product of their ` +
        'value sets is the series count; keep it to six or fewer (docs/12 §6).',
    );
  }
}

const droppedCounters = new WeakMap<MetricsRegistry, PromCounter<'metric'>>();

function seriesDropped(registry: MetricsRegistry, metricName: string): void {
  let droppedCounter = droppedCounters.get(registry);
  if (droppedCounter === undefined) {
    droppedCounter = new PromCounter({
      name: 'metric_series_dropped_total',
      help: 'Observations dropped because a metric family reached its series budget (docs/12 §6).',
      labelNames: ['metric'] as const,
      registers: [registry],
    });
    droppedCounters.set(registry, droppedCounter);
  }
  // `metric` is bounded by the number of metric families declared in this process.
  droppedCounter.inc({ metric: metricName });
  logger.warn(
    { event: 'metrics.series_budget_exceeded', metric: metricName },
    'metric series budget exceeded',
  );
}

/**
 * Normalises a caller's labels into the declared, closed shape.
 *
 * Returns `undefined` when the observation must be dropped, which happens only when the
 * family has reached its series budget. Nothing here throws — a metric helper that could
 * throw on the request path would turn an observability problem into a candidate-facing
 * one, and docs/12 is explicit that telemetry never does that.
 */
class SeriesGuard<L extends string> {
  private readonly seenSeries = new Set<string>();

  public constructor(
    private readonly metricName: string,
    private readonly labelNames: readonly L[],
    private readonly labelValues: { readonly [K in L]?: readonly string[] },
    private readonly maxSeries: number,
    private readonly registry: MetricsRegistry,
  ) {}

  public resolve(labels: MetricLabels<L> | undefined): Record<string, string> | undefined {
    if (this.labelNames.length === 0) return {};

    const resolved: Record<string, string> = {};
    const key: string[] = [];

    for (const label of this.labelNames) {
      const raw = labels === undefined ? undefined : labels[label];
      let value = raw === undefined ? UNKNOWN : String(raw);

      const allowed = this.labelValues[label];
      if (allowed !== undefined && !allowed.includes(value)) {
        value = value === UNKNOWN ? UNKNOWN : OTHER;
      }

      resolved[label] = value;
      key.push(value);
    }

    const series = key.join(' ');
    if (!this.seenSeries.has(series)) {
      if (this.seenSeries.size >= this.maxSeries) {
        seriesDropped(this.registry, this.metricName);
        return undefined;
      }
      this.seenSeries.add(series);
    }

    return resolved;
  }

  public reset(): void {
    this.seenSeries.clear();
  }
}

function prepare<L extends string>(
  spec: MetricSpec<L>,
  kind: 'counter' | 'gauge' | 'histogram',
): { labelNames: readonly L[]; registry: MetricsRegistry; guard: SeriesGuard<L> } {
  assertMetricName(spec.name, kind);

  const labelNames = spec.labelNames ?? [];
  assertLabelNames(spec.name, labelNames);

  const registry = spec.registry ?? metrics;
  if (registry.getSingleMetric(spec.name) !== undefined) {
    throw new MetricNameError(
      `metric "${spec.name}" is already registered. A metric is declared once, at module ` +
        'scope, and shared; declaring it twice silently splits the series.',
    );
  }

  const guard = new SeriesGuard<L>(
    spec.name,
    labelNames,
    spec.labelValues ?? {},
    spec.maxSeries ?? DEFAULT_MAX_SERIES,
    registry,
  );

  return { labelNames, registry, guard };
}

/** Declares a counter. Cumulative, monotonic, named `*_total`. */
export function counter<L extends string = never>(spec: MetricSpec<L>): CounterMetric<L> {
  const { labelNames, registry, guard } = prepare(spec, 'counter');

  const underlying = new PromCounter<L>({
    name: spec.name,
    help: spec.help,
    labelNames: [...labelNames],
    registers: [registry],
  });

  return {
    name: spec.name,
    inc(labels?: MetricLabels<L>, value = 1): void {
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.inc(resolved as MetricLabels<L>, value);
    },
    reset(): void {
      guard.reset();
      underlying.reset();
    },
  };
}

/** Declares a gauge. A number that goes up and down; sampled, not accumulated. */
export function gauge<L extends string = never>(spec: MetricSpec<L>): GaugeMetric<L> {
  const { labelNames, registry, guard } = prepare(spec, 'gauge');

  const underlying = new PromGauge<L>({
    name: spec.name,
    help: spec.help,
    labelNames: [...labelNames],
    registers: [registry],
  });

  function split(
    a: MetricLabels<L> | number,
    b?: number,
  ): { labels?: MetricLabels<L>; value: number } {
    if (typeof a === 'number') return { value: a };
    return { labels: a, value: b ?? 0 };
  }

  return {
    name: spec.name,
    set(a: MetricLabels<L> | number, b?: number): void {
      const { labels, value } = split(a, b);
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.set(resolved as MetricLabels<L>, value);
    },
    inc(labels?: MetricLabels<L>, value = 1): void {
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.inc(resolved as MetricLabels<L>, value);
    },
    dec(labels?: MetricLabels<L>, value = 1): void {
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.dec(resolved as MetricLabels<L>, value);
    },
    setToCurrentTime(labels?: MetricLabels<L>): void {
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.set(resolved as MetricLabels<L>, Date.now() / 1000);
    },
    reset(): void {
      guard.reset();
      underlying.reset();
    },
  };
}

/** Declares a histogram. Base units only — `_seconds`, `_bytes`, `_ratio`. */
export function histogram<L extends string = never>(spec: HistogramSpec<L>): HistogramMetric<L> {
  const { labelNames, registry, guard } = prepare(spec, 'histogram');

  const underlying = new PromHistogram<L>({
    name: spec.name,
    help: spec.help,
    labelNames: [...labelNames],
    registers: [registry],
    ...(spec.buckets === undefined ? {} : { buckets: [...spec.buckets] }),
  });

  return {
    name: spec.name,
    observe(a: MetricLabels<L> | number, b?: number): void {
      const labels = typeof a === 'number' ? undefined : a;
      const value = typeof a === 'number' ? a : (b ?? 0);
      const resolved = guard.resolve(labels);
      if (resolved === undefined) return;
      underlying.observe(resolved as MetricLabels<L>, value);
    },
    startTimer(labels?: MetricLabels<L>): () => number {
      const startedAt = process.hrtime.bigint();
      return (): number => {
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        const resolved = guard.resolve(labels);
        if (resolved !== undefined) underlying.observe(resolved as MetricLabels<L>, seconds);
        return seconds;
      };
    },
    reset(): void {
      guard.reset();
      underlying.reset();
    },
  };
}

/** The minimum a response object must offer for {@link metricsHandler} to serve a scrape. */
export interface MetricsHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/**
 * The `/metrics` handler. Structurally typed, so it takes a Node `ServerResponse` — from
 * `reply.raw` under Fastify — without this package depending on a web framework.
 *
 * A scrape that fails answers 500 with a comment line rather than a partial exposition:
 * a truncated exposition is parsed as real data and produces a wrong dashboard, which is
 * worse than a visibly failed scrape.
 */
export function metricsHandler(
  registry: MetricsRegistry = metrics,
): (req: unknown, res: MetricsHttpResponse) => void {
  return (_req: unknown, res: MetricsHttpResponse): void => {
    registry
      .metrics()
      .then((body) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', registry.contentType);
        res.end(body);
      })
      .catch((err: unknown) => {
        logger.error({ event: 'metrics.scrape_failed', err }, 'metrics scrape failed');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('# metrics unavailable\n');
      });
  };
}
