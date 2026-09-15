/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/observability — logger, tracer and metric registry shared by every service.
 *
 * Owns: the structured JSON logger and its redaction deny-list, the OpenTelemetry
 * bootstrap, the Prometheus registry, the bounded-cardinality metric helper, and the
 * request-context helper carrying trace id and org id.
 *
 * A trace id propagates from the candidate request through the queue payload into the
 * worker and the execution call. Logs never carry a token, an answer, hidden test-case
 * content or PII, and a metric may never be labelled with a candidate, attempt or
 * question id (docs/12).
 *
 * Two of those rules are enforced in code rather than in review, each with its own test:
 * redaction.ts denies the field names in docs/12 §7.2 at the serialiser, and metrics.ts
 * throws at construction on any label name whose value set is unbounded (docs/12 §6).
 *
 * This package is imported by apps. It imports `@assaybank/config` for nothing at
 * runtime and `@assaybank/contracts` for the branded `OrgId` only; it never reads
 * `process.env`, and it performs no I/O beyond writing a log line and answering a scrape.
 */

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/observability';

export { createLogger, logger } from './logger.js';
export type { CreateLoggerOptions, Logger, LogLevel } from './logger.js';

export { initTelemetry, shutdownTelemetry } from './telemetry.js';

export {
  counter,
  gauge,
  histogram,
  metrics,
  metricsHandler,
  DEFAULT_MAX_SERIES,
  MetricCardinalityError,
  MetricNameError,
  OTHER,
  UNKNOWN,
} from './metrics.js';
export type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  HistogramSpec,
  MetricLabels,
  MetricsHttpResponse,
  MetricsRegistry,
  MetricSpec,
} from './metrics.js';

export { currentContext, withContext } from './context.js';
export type { RequestContext } from './context.js';

export { REDACTED } from './redaction.js';
