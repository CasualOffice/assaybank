/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Liveness and readiness, which are two different questions and must never be one route.
 *
 * `/healthz` asks **"is this process alive?"** and checks nothing but its own existence.
 * `/readyz` asks **"should this process be sent traffic right now?"** and checks Postgres
 * and Valkey.
 *
 * **Conflating them causes the outage it looks like it would prevent.** An orchestrator
 * restarts a container whose *liveness* probe fails. If liveness checked the database, a
 * thirty-second Postgres blip would fail the probe on every API pod simultaneously, and
 * the orchestrator would restart the entire API tier at once — turning a recovered
 * database into an empty cluster with a cold start, at the exact moment a cohort of
 * candidates is mid-exam. Readiness failing merely removes a pod from the load balancer;
 * the pod keeps its process, its warm caches and its in-flight requests, and returns when
 * the dependency does. So the dependency checks live behind `/readyz`, and `/healthz`
 * answers 200 for as long as the event loop can answer anything at all — including while
 * the process is draining for shutdown, because a draining pod is alive and killing it
 * mid-drain is how in-flight work is lost.
 *
 * Neither route reveals anything about *why* a dependency is unhealthy. The client of
 * these endpoints is an orchestrator that only branches on the status code, and a
 * connection error string carries a DSN, a host name and sometimes a role name.
 */

import type { FastifyInstance } from 'fastify';

import type { ServerState } from './state.js';

/**
 * One dependency `/readyz` is willing to be held responsible for.
 *
 * `probe` resolves when the dependency answered and rejects otherwise; it returns
 * nothing, because anything it could return would be tempting to serve.
 */
export interface DependencyProbe {
  /** A short, fixed name: `postgres`, `valkey`. Appears in the readiness body. */
  readonly name: string;
  /** Resolves if the dependency is reachable. Rejects, or hangs, if it is not. */
  probe(): Promise<void>;
}

/** Per-dependency result, as served. */
export interface DependencyStatus {
  readonly name: string;
  readonly status: 'ok' | 'down';
  readonly latency_ms: number;
}

/** The `/readyz` body. */
export interface ReadinessBody {
  readonly status: 'ready' | 'not_ready';
  readonly service: string;
  /** True once SIGTERM has been received: alive, finishing work, taking nothing new. */
  readonly draining: boolean;
  /** ADR-006: the server's clock is the only clock this system trusts. */
  readonly server_time: string;
  readonly checks: readonly DependencyStatus[];
}

/** The `/healthz` body. */
export interface LivenessBody {
  readonly status: 'ok';
  readonly service: string;
  readonly uptime_seconds: number;
  readonly server_time: string;
}

/**
 * How long a single probe may take before it counts as down.
 *
 * A probe with no timeout is worse than no probe: a Postgres that accepts the connection
 * and never answers leaves `/readyz` hanging, the orchestrator's own probe times out,
 * and the pod is marked unready by timeout with no per-dependency detail in the body —
 * which is the one thing this endpoint exists to provide.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/** Options for {@link registerHealthRoutes}. */
export interface HealthRoutesOptions {
  readonly state: ServerState;
  readonly dependencies?: readonly DependencyProbe[] | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Log level for the two routes. They are probed every few seconds by the orchestrator,
   * so at `info` they would drown every line that matters during an incident.
   */
  readonly logLevel?: 'warn' | 'info' | undefined;
}

class ProbeTimeout extends Error {
  constructor(name: string, ms: number) {
    super(`dependency "${name}" did not answer within ${String(ms)}ms`);
    this.name = 'ProbeTimeout';
  }
}

async function withTimeout(dependency: DependencyProbe, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      dependency.probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProbeTimeout(dependency.name, ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Installs `GET /healthz` and `GET /readyz`. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRoutesOptions): void {
  const { state } = options;
  const dependencies = options.dependencies ?? [];
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options.now ?? ((): Date => new Date());
  const logLevel = options.logLevel ?? 'warn';

  app.get('/healthz', { logLevel }, (_request, reply): LivenessBody => {
    // No dependency is consulted here, ever. See the module comment — this is the
    // deliberate half of the liveness/readiness split, not an oversight to be helpfully
    // corrected by a later change.
    void reply.code(200);
    return {
      status: 'ok',
      service: state.service,
      uptime_seconds: Math.round((now().getTime() - state.startedAt.getTime()) / 1000),
      server_time: now().toISOString(),
    };
  });

  app.get('/readyz', { logLevel }, async (request, reply): Promise<ReadinessBody> => {
    const checks = await Promise.all(
      dependencies.map(async (dependency): Promise<DependencyStatus> => {
        const startedAt = process.hrtime.bigint();
        const elapsed = (): number => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

        try {
          await withTimeout(dependency, timeoutMs);
          return { name: dependency.name, status: 'ok', latency_ms: elapsed() };
        } catch (err: unknown) {
          // The reason is logged, never served: a connection error carries the DSN, the
          // host and sometimes the role name, and /readyz is reachable by anything that
          // can reach the pod.
          request.log.warn(
            { event: 'readiness.dependency_down', dependency: dependency.name, err },
            'readiness probe failed',
          );
          return { name: dependency.name, status: 'down', latency_ms: elapsed() };
        }
      }),
    );

    const healthy = checks.every((check) => check.status === 'ok');
    // Draining is reported as not ready even with every dependency healthy: SIGTERM has
    // been received, and the load balancer should stop sending new work while the
    // in-flight requests finish (docs/13 §7).
    const ready = healthy && !state.draining;

    void reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      service: state.service,
      draining: state.draining,
      server_time: now().toISOString(),
      checks,
    };
  });
}
