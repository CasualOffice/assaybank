/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The worker's only HTTP surface: `/healthz` and `/metrics`, on a port of its own.
 *
 * CODE-GRAPH's `worker` invariants: "Holds no candidate-facing HTTP surface; everything
 * it produces reaches a client through Postgres or the API." This listener exists so
 * Prometheus can scrape the queue depth and so the container has a health check, and it
 * serves nothing else — an unrecognised path is a 404, not a route waiting to be added.
 *
 * Port 9464 is fixed in `infra/prometheus/prometheus.yml` (`targets: ["worker:9464"]`)
 * and in the compose health check. It is a constant here rather than a configuration
 * variable because all three would have to change together and only one of them would
 * be remembered.
 *
 * `/healthz` answers liveness only — is this process running — and deliberately does not
 * check Valkey. docs/17 and step 8 of the P0 plan draw that line for the API and it holds
 * here for the same reason: a readiness check wired to a health check restarts every
 * replica at once during a transient blip, which is how a queue backlog becomes an
 * outage.
 */

import { metrics, metricsHandler } from '@assaybank/observability';
import type { Logger, MetricsRegistry } from '@assaybank/observability';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * The scrape port. Fixed in `infra/prometheus/prometheus.yml` and in the compose health
 * check; changing it is a three-file edit.
 */
export const WORKER_METRICS_PORT = 9464;

/** Options for {@link createTelemetryServer}. */
export interface TelemetryServerOptions {
  /** Defaults to the shared registry from `@assaybank/observability`. */
  readonly registry?: MetricsRegistry | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Builds the listener. Not started: {@link startTelemetryServer} does that, so a test can
 * exercise the routing on an ephemeral port without a fixed one being taken.
 */
export function createTelemetryServer(options: TelemetryServerOptions = {}): Server {
  const registry = options.registry ?? metrics;
  const scrape = metricsHandler(registry);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, 'method not allowed\n');
      return;
    }

    if (path === '/healthz') {
      respond(res, 200, 'ok\n');
      return;
    }

    if (path === '/metrics') {
      scrape(req, res);
      return;
    }

    respond(res, 404, 'not found\n');
  });
}

function respond(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

/** A started listener, and the way to stop it. */
export interface RunningTelemetryServer {
  readonly server: Server;
  /** The port actually bound, which differs from the requested one when it was 0. */
  readonly port: number;
  close(): Promise<void>;
}

/** Options for {@link startTelemetryServer}. */
export interface StartTelemetryServerOptions extends TelemetryServerOptions {
  /** Defaults to {@link WORKER_METRICS_PORT}. Pass 0 in a test for an ephemeral port. */
  readonly port?: number | undefined;
  /** Defaults to every interface, which is what a container needs. */
  readonly host?: string | undefined;
}

/** Starts the listener and resolves once it is accepting connections. */
export async function startTelemetryServer(
  options: StartTelemetryServerOptions = {},
): Promise<RunningTelemetryServer> {
  const server = createTelemetryServer(options);
  const port = options.port ?? WORKER_METRICS_PORT;
  const host = options.host ?? '0.0.0.0';

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  options.logger?.info(
    { event: 'telemetry_server.listening', port: boundPort, host },
    'worker telemetry listener started',
  );

  return {
    server,
    port: boundPort,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
        // Scrapes are short and keep-alive connections are not worth draining; without
        // this a shutdown waits for Prometheus's idle socket to time out.
        server.closeIdleConnections();
      }),
  };
}
