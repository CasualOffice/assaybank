/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The HTTP metrics of docs/12 §4.6, and the hook that records them.
 *
 * `http_request_duration_seconds` is the PRD §8 NFR made measurable: p95 below 300 ms on
 * non-execution routes. The buckets are placed around that line rather than at
 * prom-client's defaults, because a histogram whose buckets straddle the objective
 * cannot answer whether the objective was met.
 *
 * **The labels are `route_class`, `method` and `status_class`, and that is not a
 * stylistic choice.** docs/12 §6 and the guard in `@assaybank/observability` both refuse
 * `route` — a resolved path such as `/attempts/7f3a…/answers` carries an attempt id, and
 * one unbounded label destroys the metrics tier at peak, which is precisely when it is
 * the only tool available. `route_class` is the *templated* route, so every attempt
 * shares one series. `status_class` is `2xx`/`4xx`/`5xx` rather than the numeric status
 * for the same reason at a smaller scale, and because the alert in docs/12 is written
 * against the class.
 *
 * An unmatched request contributes `unmatched`, never its URL: a scanner probing a
 * thousand paths must not be able to mint a thousand series.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  counter,
  histogram,
  type CounterMetric,
  type HistogramMetric,
} from '@assaybank/observability';

/** The label set shared by the two request metrics. */
type RequestLabel = 'route_class' | 'method' | 'status_class';

/** `route_class` for a request that matched no route. */
export const UNMATCHED_ROUTE_CLASS = 'unmatched';

/**
 * The closed set of methods this API speaks. Anything else folds to `other` in the
 * observability wrapper rather than becoming a new series.
 */
const METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** The closed set of status classes. */
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;

/**
 * Buckets in seconds, dense below the 300 ms objective and sparse above it. The 0.3
 * boundary is present exactly so the SLO query is a bucket ratio rather than an
 * interpolation.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10] as const;

const LABEL_VALUES = {
  method: METHODS,
  status_class: STATUS_CLASSES,
} as const;

/** docs/12 §4.6 — the PRD §8 latency NFR. */
export const httpRequestDuration: HistogramMetric<RequestLabel> = histogram<RequestLabel>({
  name: 'http_request_duration_seconds',
  help:
    'Duration of an HTTP request, in seconds, by templated route, method and status ' +
    'class. The PRD §8 objective is p95 < 0.3 on non-execution routes.',
  labelNames: ['route_class', 'method', 'status_class'],
  labelValues: LABEL_VALUES,
  buckets: [...DURATION_BUCKETS],
});

/** docs/12 §4.6 — request rate and the 5xx ratio the paging alert is written against. */
export const httpRequestsTotal: CounterMetric<RequestLabel> = counter<RequestLabel>({
  name: 'http_requests_total',
  help: 'HTTP requests served, by templated route, method and status class.',
  labelNames: ['route_class', 'method', 'status_class'],
  labelValues: LABEL_VALUES,
});

/**
 * Turns a Fastify route pattern into the `route_class` label value.
 *
 * Fastify writes parameters as `:id` and a wildcard as `*`; docs/12 writes the templated
 * route as `/attempts/{id}/answers`. Normalising here keeps the dashboards written in
 * the documented form, and keeps the value derived from the route table — a closed set
 * that grows only when someone adds a route — rather than from the request.
 */
export function routeClassOf(pattern: string | undefined): string {
  if (pattern === undefined || pattern === '') return UNMATCHED_ROUTE_CLASS;
  return pattern.replace(/:([A-Za-z0-9_]+)/gu, '{$1}').replace(/\*/gu, '{wildcard}');
}

/** `2xx`, `4xx`, … for a numeric status. Anything unexpected folds to `5xx`. */
export function statusClassOf(status: number): string {
  const hundreds = Math.floor(status / 100);
  return hundreds >= 1 && hundreds <= 5 ? `${String(hundreds)}xx` : '5xx';
}

/** The `route_class` of a request, whether or not it matched a route. */
export function requestRouteClass(request: FastifyRequest): string {
  return routeClassOf(request.routeOptions.url);
}

/**
 * Installs the `onResponse` hook that records both metrics.
 *
 * `onResponse` rather than `onSend`, because the number the NFR is about is the one the
 * client waited for, which includes serialisation. Nothing here can throw: an observation
 * that failed a request would turn a monitoring problem into a candidate-facing one.
 */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    const labels = {
      route_class: requestRouteClass(request),
      method: request.method,
      status_class: statusClassOf(reply.statusCode),
    } as const;

    // Fastify measures this in milliseconds; Prometheus convention is base units, and
    // docs/12 §4 rejects a `_ms` metric outright.
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);

    done();
  });
}
