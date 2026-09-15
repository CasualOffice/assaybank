/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The OpenTelemetry bootstrap (docs/12 §5).
 *
 * W3C Trace Context is the only propagation format, and the API is the trace root for
 * candidate traffic: an inbound `traceparent` from a browser is never adopted as a
 * parent, because a candidate's browser is not a trusted source of trace ids.
 *
 * Telemetry is best-effort. A collector that is down, a malformed endpoint or a missing
 * instrumentation degrades observability; it never fails a boot, a request or a job. So
 * every path here is wrapped and logged rather than thrown.
 *
 * The SDK and the instrumentation bundle are imported dynamically. Loading
 * `@opentelemetry/auto-instrumentations-node` pulls in several dozen instrumentation
 * packages and installs require hooks, which no consumer of `logger` or `metrics` should
 * pay for just by importing this workspace.
 */

import { collectDefaultMetrics } from 'prom-client';

import { logger } from './logger.js';
import { metrics } from './metrics.js';

interface TelemetrySdk {
  start(): void;
  shutdown(): Promise<void>;
}

let sdk: TelemetrySdk | undefined;
let defaultMetricsStarted = false;

/**
 * Starts tracing for this service and registers the process metrics Prometheus expects.
 *
 * Called once, as early in a service's boot as possible — instrumentation that is
 * installed after a module has been required does not patch it. Calling it twice is a
 * no-op rather than an error, so a test harness that boots an app repeatedly is safe.
 *
 * Exporter configuration (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER`, …) is
 * read by the SDK from the environment; this package never touches `process.env` itself.
 */
export async function initTelemetry(serviceName: string): Promise<void> {
  if (!defaultMetricsStarted) {
    // process_*, nodejs_* — event-loop lag and heap are the first things an on-call
    // engineer looks at, and they are free.
    collectDefaultMetrics({ register: metrics });
    defaultMetricsStarted = true;
  }

  if (sdk !== undefined) return;

  try {
    const [
      { NodeSDK },
      { getNodeAutoInstrumentations },
      { OTLPTraceExporter },
      resources,
      semconv,
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/auto-instrumentations-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

    const instance = new NodeSDK({
      serviceName,
      resource: resources
        .defaultResource()
        .merge(resources.resourceFromAttributes({ [semconv.ATTR_SERVICE_NAME]: serviceName })),
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // A span per filesystem call buries the spans that matter, and DNS and net
          // spans duplicate what the http instrumentation already records.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
        }),
      ],
    });

    instance.start();
    sdk = instance;
    logger.info(
      { event: 'telemetry.started', otel_service_name: serviceName },
      'telemetry started',
    );
  } catch (err) {
    logger.warn(
      { event: 'telemetry.start_failed', err },
      'telemetry bootstrap failed; continuing without tracing',
    );
  }
}

/**
 * Flushes and stops the SDK. Called from the service's shutdown hook, before the process
 * exits, so the spans describing the shutdown itself are exported rather than lost —
 * which is exactly the window in which an incident's evidence tends to disappear.
 */
export async function shutdownTelemetry(): Promise<void> {
  const instance = sdk;
  if (instance === undefined) return;
  sdk = undefined;

  try {
    await instance.shutdown();
    logger.info({ event: 'telemetry.stopped' }, 'telemetry stopped');
  } catch (err) {
    logger.warn({ event: 'telemetry.stop_failed', err }, 'telemetry shutdown failed');
  }
}
