/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@assaybank/worker` — the BullMQ consumer and the host of every scheduled sweep.
 *
 * Owns: the six-queue registry (`queues.ts`), each queue declared once with its
 * concurrency, attempt limit, backoff and dead-letter policy; the dead-letter routing
 * that makes an exhausted job visible instead of absent (`dlq.ts`); the queue metrics
 * docs/12 §4.1 fixes (`metrics.ts`); idempotency by business key (`idempotency.ts`); and
 * the six scheduled sweeps from `code-graph.json` (`jobs/scheduled.ts`).
 *
 * One job equals one submission and grading is idempotent by submission id (ADR-008). A
 * job that exhausts its attempts lands in a dead-letter queue, pages, and moves the
 * attempt to `under_review` — it never writes a silent zero. The worker compares
 * test-case expectations itself and never sends an expectation into the sandbox. It holds
 * no candidate-facing HTTP surface: `/healthz` and `/metrics` on port 9464, and nothing
 * else.
 *
 * **What P0 builds here and what it does not.** The skeleton is real: the registry, the
 * dead-letter path, the metrics, the trace hop across the queue, the idempotency helper,
 * the schedules and the graceful shutdown all work and are tested. The work each sweep
 * does is not written yet — there is no domain in P0 — so every sweep handler is a
 * declared placeholder that says which milestone implements it, and one no-op example job
 * is enqueued at boot to exercise the whole lifecycle end to end.
 */

import { config } from '@assaybank/config';
import { createLogger, initTelemetry, shutdownTelemetry } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { UnrecoverableError } from 'bullmq';
import type { ConnectionOptions, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pathToFileURL } from 'node:url';

import { startTelemetryServer, WORKER_METRICS_PORT } from './http.js';
import type { RunningTelemetryServer } from './http.js';
import { createRedisIdempotencyStore, setIdempotencyStore, toJobId } from './idempotency.js';
import {
  EXAMPLE_JOB_NAME,
  exampleJobKey,
  exampleJobPayload,
  runExampleJob,
} from './jobs/example.js';
import {
  isScheduledJobName,
  repeatOptionsFor,
  SCHEDULED_JOB_NAMES,
  SCHEDULED_JOBS,
  runScheduledJob,
} from './jobs/scheduled.js';
import { createQueue, createWorker, defaultConnection, QUEUES } from './queues.js';
import type { JobHandler } from './queues.js';
import { startDepthSampler } from './sampler.js';
import type { RunningSampler } from './sampler.js';
import { injectTraceContext } from './trace-context.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/worker';

/**
 * How long a shutdown waits for in-flight jobs before forcing the issue.
 *
 * Long enough for a grading job to finish — a ten-case question at the wall-time limit is
 * most of a minute — and short enough to be inside a container runtime's own kill grace.
 * A job that does not finish in time is returned to the queue rather than lost; BullMQ
 * redelivers it and every job here is idempotent, which is what makes forcing safe.
 */
export const SHUTDOWN_GRACE_MS = 45_000;

/** Options for {@link start}. Every one has a production-correct default. */
export interface StartOptions {
  readonly logger?: Logger | undefined;
  readonly connection?: ConnectionOptions | undefined;
  /** Defaults to {@link WORKER_METRICS_PORT}. A test passes 0. */
  readonly metricsPort?: number | undefined;
  /** Defaults to true. False leaves the six schedules unregistered. */
  readonly registerSchedules?: boolean | undefined;
  /** Defaults to true. The no-op example job that proves the lifecycle. */
  readonly enqueueExampleJob?: boolean | undefined;
  /** Defaults to true. False skips the OpenTelemetry SDK, which a test does not want. */
  readonly telemetry?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

/** A running worker process. */
export interface WorkerRuntime {
  readonly logger: Logger;
  /** The port the telemetry listener bound to. */
  readonly metricsPort: number;
  readonly maintenanceQueue: Queue<unknown, unknown, string>;
  readonly maintenanceWorker: Worker<unknown, unknown, string>;
  /** Drains in-flight jobs, then releases every handle. Safe to call twice. */
  stop(reason: string): Promise<void>;
}

/**
 * Boots the worker.
 *
 * Order matters in one place: telemetry is initialised before anything that could emit a
 * span, and the idempotency store is installed before any worker starts consuming. The
 * rest is independent.
 */
export async function start(options: StartOptions = {}): Promise<WorkerRuntime> {
  const now = options.now ?? ((): Date => new Date());

  if (options.telemetry !== false) {
    await initTelemetry(config.telemetry.serviceName);
  }

  const logger =
    options.logger ??
    createLogger({
      service: config.telemetry.serviceName,
      env: config.core.appEnv,
      level: config.core.logLevel,
      pretty: !config.core.isDeployedTier,
    });

  const connection = options.connection ?? defaultConnection();

  logger.info(
    {
      event: 'worker.starting',
      workspace: WORKSPACE_NAME,
      queues: Object.keys(QUEUES),
      scheduled_jobs: SCHEDULED_JOB_NAMES,
    },
    'worker starting',
  );

  // The idempotency record must be shared by every replica: a result remembered in one
  // process's heap is not remembered by the replica that receives the redelivery.
  const redis = new Redis(config.valkey.url, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on('error', (err: Error) => {
    logger.error({ event: 'valkey.error', err }, 'valkey connection error');
  });
  setIdempotencyStore(createRedisIdempotencyStore(redis));

  const maintenanceQueue = createQueue<unknown, unknown>('maintenance.cron', { connection });

  const handler: JobHandler<unknown, unknown> = async (job) => {
    if (job.name === EXAMPLE_JOB_NAME) {
      return runExampleJob(job.data, { logger, now });
    }
    if (isScheduledJobName(job.name)) {
      // The tick this job was scheduled for. Derived from the job rather than from its
      // payload, because a scheduler template is static and two replicas processing the
      // same tick must compute the same idempotency key.
      return runScheduledJob(job.name, { logger, scheduledFor: new Date(job.timestamp) });
    }
    // Retrying cannot turn an unknown job name into a known one, so the attempt budget is
    // not spent on it: it goes straight to the dead-letter queue, where an operator can
    // see that a deploy changed a job shape without a migration path (RB-02).
    throw new UnrecoverableError(
      `no handler for job "${job.name}" on maintenance.cron; it was dead-lettered unretried`,
    );
  };

  const maintenanceWorker = createWorker<unknown, unknown>('maintenance.cron', handler, {
    connection,
    logger,
    now,
  });

  if (options.registerSchedules !== false) {
    await registerSchedules(maintenanceQueue, logger);
  }

  if (options.enqueueExampleJob !== false) {
    await enqueueExampleJob(maintenanceQueue, logger, now);
  }

  const sampler = startDepthSampler({ logger, connection });

  const telemetryServer = await startTelemetryServer({
    logger,
    port: options.metricsPort ?? WORKER_METRICS_PORT,
  });

  logger.info(
    {
      event: 'worker.started',
      metrics_port: telemetryServer.port,
      concurrency: QUEUES['maintenance.cron'].concurrency(config.queues),
    },
    'worker started',
  );

  let stopping: Promise<void> | undefined;

  const stop = (reason: string): Promise<void> => {
    stopping ??= shutdown({
      reason,
      logger,
      worker: maintenanceWorker,
      queue: maintenanceQueue,
      sampler,
      telemetryServer,
      redis,
      shutdownOtel: options.telemetry !== false,
    });
    return stopping;
  };

  return {
    logger,
    metricsPort: telemetryServer.port,
    maintenanceQueue,
    maintenanceWorker,
    stop,
  };
}

/**
 * Registers the six schedules.
 *
 * `upsertJobScheduler` is idempotent by key, so a restart re-asserts the schedule rather
 * than duplicating it, and a cadence changed in `SCHEDULED_JOBS` takes effect on the next
 * deploy without anyone deleting a repeatable key by hand.
 */
export async function registerSchedules(
  queue: Queue<unknown, unknown, string>,
  logger: Logger,
): Promise<void> {
  for (const name of SCHEDULED_JOB_NAMES) {
    const spec = SCHEDULED_JOBS[name];
    await queue.upsertJobScheduler(name, repeatOptionsFor(spec.cadence), {
      name,
      data: injectTraceContext({ job_key: name }),
    });
    logger.info(
      {
        event: 'sweep.scheduled',
        job: name,
        cadence: spec.cadence,
        milestone: spec.milestone,
      },
      `${spec.title} scheduled`,
    );
  }
}

/**
 * Enqueues the no-op example job once.
 *
 * The job id is its business key, so a restart loop cannot pile up copies of the same
 * tick, and the trace context is injected at the producer exactly as `apps/api` will
 * inject it when it starts enqueueing (docs/12 §5.2).
 */
export async function enqueueExampleJob(
  queue: Queue<unknown, unknown, string>,
  logger: Logger,
  now: () => Date,
): Promise<void> {
  const payload = exampleJobPayload(now());
  const key = exampleJobKey(payload);
  await queue.add(EXAMPLE_JOB_NAME, injectTraceContext(payload), { jobId: toJobId(key) });
  logger.info(
    { event: 'job.enqueued', queue: 'maintenance.cron', job_name: EXAMPLE_JOB_NAME, job_id: key },
    'example job enqueued',
  );
}

interface ShutdownInput {
  readonly reason: string;
  readonly logger: Logger;
  readonly worker: Worker<unknown, unknown, string>;
  readonly queue: Queue<unknown, unknown, string>;
  readonly sampler: RunningSampler;
  readonly telemetryServer: RunningTelemetryServer;
  readonly redis: Redis;
  readonly shutdownOtel: boolean;
}

/**
 * Graceful shutdown: stop taking work, let what is running finish, then release.
 *
 * The order is the point. Closing the worker first stops it fetching, and BullMQ's
 * non-forced `close()` waits for the jobs already in hand — which is the difference
 * between a rolling restart that costs nothing and one that returns a hundred half-done
 * jobs to the queue. Everything else is closed after, because a job still running needs
 * its Valkey connection.
 */
async function shutdown(input: ShutdownInput): Promise<void> {
  const { logger } = input;
  logger.info({ event: 'worker.stopping', reason: input.reason }, 'worker stopping');

  await input.sampler.stop().catch((err: unknown) => {
    logger.warn({ event: 'worker.sampler_stop_failed', err }, 'depth sampler did not stop cleanly');
  });

  const drained = await withTimeout(input.worker.close(), SHUTDOWN_GRACE_MS);
  if (!drained) {
    logger.warn(
      { event: 'worker.drain_timeout', grace_ms: SHUTDOWN_GRACE_MS },
      'in-flight jobs did not finish within the grace period; they return to the queue and ' +
        'will be redelivered, which is safe because every job is idempotent (ADR-008)',
    );
    await input.worker.close(true).catch(() => undefined);
  }

  await Promise.allSettled([
    input.queue.close(),
    input.telemetryServer.close(),
    input.redis.quit(),
  ]);

  if (input.shutdownOtel) await shutdownTelemetry();

  logger.info({ event: 'worker.stopped', reason: input.reason }, 'worker stopped');
}

/** Resolves true if `work` finished in time, false if the deadline passed first. */
async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref();
  });

  try {
    return await Promise.race([work.then(() => true), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Installs the signal handlers and blocks until one arrives.
 *
 * `SIGTERM` is what a container runtime sends; `SIGINT` is Ctrl-C. Both take the same
 * path, because a developer interrupting a local stack should see the same drain a
 * deploy does — otherwise the drain is only ever exercised in production.
 */
export async function main(): Promise<void> {
  const runtime = await start();

  const onSignal = (signal: NodeJS.Signals): void => {
    void runtime.stop(signal).then(
      () => {
        process.exitCode = 0;
      },
      (err: unknown) => {
        runtime.logger.error({ event: 'worker.stop_failed', err }, 'shutdown failed');
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  process.on('unhandledRejection', (reason: unknown) => {
    // Never swallowed: an unhandled rejection in a worker is a job whose outcome nobody
    // recorded, which is the exact failure docs/12 §1 calls the expensive kind.
    runtime.logger.fatal(
      { event: 'worker.unhandled_rejection', err: reason },
      'unhandled rejection',
    );
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
