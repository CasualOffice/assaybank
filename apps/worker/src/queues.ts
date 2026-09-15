/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The queue registry: every queue declared once, with its concurrency, attempt limit,
 * backoff curve and dead-letter behaviour.
 *
 * docs/17 §6 states the rule this file enforces — "every queue is declared once in the
 * registry ... never configured ad hoc at a call site". The failure it prevents is
 * specific and has happened to everyone: one producer passes `attempts: 5`, another
 * forgets `attempts` entirely and gets BullMQ's default of 1, and the second one is the
 * queue that loses a candidate's submission on a transient failure. Here, a call site
 * names a queue and gets that queue's policy; there is no parameter to get wrong.
 *
 * Two things are resolved from configuration rather than frozen into the table, and both
 * are declared as functions of {@link QueuesConfig} rather than read at module load:
 * concurrency and the attempt budget. That keeps the registry a value — importable,
 * inspectable and unit-testable with a fixture — in a process whose environment has not
 * been parsed, which is exactly the situation a test runs in.
 *
 * **`webhooks.deliver` does not use `QUEUE_MAX_ATTEMPTS`.** It carries its own limit of
 * eight and its own backoff curve, configured on the queue rather than globally
 * (docs/09 §5.2). A grading job and a webhook delivery have genuinely different retry
 * economics: a candidate is waiting for one and nobody is waiting for the other.
 */

import { config } from '@assaybank/config';
import type { QueuesConfig } from '@assaybank/config';
import { logger as defaultLogger } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type {
  BackoffOptions,
  ConnectionOptions,
  Job,
  JobsOptions,
  Processor,
  WorkerOptions,
} from 'bullmq';

import { handleJobFailure } from './dlq.js';
import type { DeadLetterSink } from './dlq.js';
import {
  classifyFailure,
  jobDuration,
  jobFailed,
  jobMissingContext,
  observeTimeInQueue,
  workersActive,
} from './metrics.js';
import {
  DEAD_LETTER_QUEUE_NAMES,
  deadLetterQueueName,
  DLQ_SUFFIX,
  isQueueName,
  QUEUE_NAMES,
  QUEUE_PRIORITY,
} from './queue-names.js';
import type { DeadLetterQueueName, QueueName, QueuePriority, QueueTier } from './queue-names.js';
import { activeTraceId, extractTraceContext, runInJobSpan } from './trace-context.js';

export {
  DEAD_LETTER_QUEUE_NAMES,
  deadLetterQueueName,
  DLQ_SUFFIX,
  isQueueName,
  QUEUE_NAMES,
  QUEUE_PRIORITY,
};
export type { DeadLetterQueueName, QueueName, QueuePriority, QueueTier };

// --- the numbers, named ---------------------------------------------------------

/**
 * `webhooks.deliver`'s own attempt limit (docs/09 §5.2). Eight attempts spread across a
 * 24-hour window, deliberately not `QUEUE_MAX_ATTEMPTS`.
 */
export const WEBHOOK_DELIVERY_ATTEMPTS = 8;

/**
 * The delay before each webhook retry, in milliseconds, from the table in docs/09 §5.2:
 * 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h. Seven delays for eight attempts — the
 * first attempt is immediate — summing to about 20.6 hours nominal.
 *
 * Nominal is the operative word: with {@link JITTER_RATIO} applied upward on every delay
 * the eighth attempt can fall past the 24-hour mark. That is expected. The window is a
 * ceiling enforced by the `webhook-reaper` sweep, which closes out a delivery whose 24
 * hours have expired regardless of how many attempts it has left — a delay table that
 * also had to guarantee the deadline would have to shrink the useful retries to do it.
 */
export const WEBHOOK_BACKOFF_SCHEDULE_MS: readonly number[] = [
  10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
];

/** The 24-hour ceiling the schedule must fit inside (docs/03 §12, docs/09 §5.2). */
export const WEBHOOK_RETRY_WINDOW_MS = 86_400_000;

/**
 * ±20% on every delay (docs/09 §5.2), so a customer endpoint coming back from an outage
 * is not hit by every queued delivery in the same second.
 */
export const JITTER_RATIO = 0.2;

/**
 * `grading.run`'s ceiling. A candidate waiting on the editor would rather see an error
 * than a long retry, so the interactive queue caps at two however high
 * `QUEUE_MAX_ATTEMPTS` is set (`code-graph.json`).
 */
export const GRADING_RUN_MAX_ATTEMPTS = 2;

/**
 * `bank.jobs` retries twice and no more: a half-applied import is worse than a reported
 * failure, and the job row records the error list the operator sees.
 */
export const BANK_JOB_ATTEMPTS = 2;

/** A missed maintenance tick is caught by the next one, so there is no retry. */
export const MAINTENANCE_ATTEMPTS = 1;

/** One run per job key at a time, across every worker replica. */
export const MAINTENANCE_CONCURRENCY = 1;

/** The custom BullMQ backoff strategy name used by a queue with an explicit curve. */
export const SCHEDULE_BACKOFF_TYPE = 'assaybank.schedule';

// --- the registry's types -------------------------------------------------------

/** Resolves a queue's worker concurrency from the parsed environment. */
export type ConcurrencyResolver = (queues: QueuesConfig) => number;

/** Resolves a queue's attempt budget from the parsed environment. */
export type AttemptsResolver = (queues: QueuesConfig) => number;

/**
 * How the delay before a retry is computed.
 *
 * `exponential` doubles from a base delay; `schedule` walks a fixed table. Both apply
 * jitter. Two shapes rather than one parameterised shape because the webhook curve is
 * not an exponential with different constants — it is a table someone chose, published
 * in an integration guide and committed to customers.
 */
export type BackoffSpec =
  | {
      readonly kind: 'exponential';
      /** The first retry's delay, before jitter. */
      readonly baseDelayMs: (queues: QueuesConfig) => number;
      readonly jitterRatio: number;
    }
  | {
      readonly kind: 'schedule';
      /** Delay before attempt n+1, indexed from zero. The last entry repeats if needed. */
      readonly delaysMs: readonly number[];
      readonly jitterRatio: number;
    };

/** What happens to a job that has spent its last attempt. */
export interface DeadLetterSpec {
  /** Derived from the queue name; not separately configurable (see `queue-names.ts`). */
  readonly queue: DeadLetterQueueName;
  /**
   * Always `page`. docs/12 §12 fires `DeadLetterQueueNonEmpty` on `bullmq_dlq_depth > 0`
   * for any queue and pages at any hour — the field is typed as a single literal so that
   * "downgrade this one to a ticket" is a change to the alerting policy rather than a
   * one-line edit here.
   */
  readonly alarm: 'page';
  /**
   * The domain consequence, in the words of `code-graph.json`. This is what happens
   * *instead of* a score: no queue in this system responds to exhausted retries by
   * recording a zero.
   */
  readonly consequence: string;
}

/** One queue's complete policy. */
export interface QueueSpec<K extends QueueName = QueueName> {
  readonly name: K;
  /** The `priority` metric label (docs/12 §4.1). */
  readonly priority: QueuePriority;
  /** The scheduling class `code-graph.json` records. */
  readonly tier: QueueTier;
  readonly concurrency: ConcurrencyResolver;
  /** The environment variable the concurrency comes from, for the runbook. */
  readonly concurrencyEnv: string;
  readonly attempts: AttemptsResolver;
  readonly backoff: BackoffSpec;
  readonly deadLetter: DeadLetterSpec;
  /**
   * The business key a job's id is set to, which is what makes a replayed enqueue a
   * no-op rather than a second execution (ADR-008, docs/17 §6).
   */
  readonly jobIdKey: string;
  readonly notes: string;
}

// --- the registry ----------------------------------------------------------------

/**
 * Every queue in the system. The six names come from `code-graph.json`; there is no
 * seventh without an edit there first.
 */
export const QUEUES: { readonly [K in QueueName]: QueueSpec<K> } = {
  'grading.run': {
    name: 'grading.run',
    priority: 'interactive',
    tier: 'high',
    concurrency: (queues) => queues.runConcurrency,
    concurrencyEnv: 'QUEUE_RUN_CONCURRENCY',
    // min(2, QUEUE_MAX_ATTEMPTS): a candidate is watching the editor.
    attempts: (queues) => Math.min(GRADING_RUN_MAX_ATTEMPTS, queues.maxAttempts),
    backoff: {
      kind: 'exponential',
      baseDelayMs: (queues) => queues.backoffMs,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('grading.run'),
      alarm: 'page',
      consequence:
        'Surfaced to the candidate as a run failure. A trial run is never recorded as a score.',
    },
    jobIdKey: 'submission_id',
    notes:
      'Sample cases only, on its own high-priority queue so a grading backlog never ' +
      'stalls the editor (ADR-008). Subject to the per-attempt execution budget.',
  },

  'grading.submit': {
    name: 'grading.submit',
    priority: 'batch',
    tier: 'normal',
    concurrency: (queues) => queues.submitConcurrency,
    concurrencyEnv: 'QUEUE_SUBMIT_CONCURRENCY',
    attempts: (queues) => queues.maxAttempts,
    backoff: {
      kind: 'exponential',
      baseDelayMs: (queues) => queues.backoffMs,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('grading.submit'),
      alarm: 'page',
      consequence:
        'The attempt moves to under_review and waits for a human. It never scores zero ' +
        'and it never finalises silently (docs/17 §6, RB-02).',
    },
    jobIdKey: 'submission_id',
    notes: 'The only queue whose jobs write a score. Every dead letter is a candidate waiting.',
  },

  'webhooks.deliver': {
    name: 'webhooks.deliver',
    priority: 'batch',
    tier: 'normal',
    // A dedicated variable is still TBD in code-graph.json; until it exists the queue
    // shares the submit default rather than inventing an undocumented one.
    concurrency: (queues) => queues.submitConcurrency,
    concurrencyEnv: 'QUEUE_SUBMIT_CONCURRENCY (shared default; dedicated variable TBD)',
    // Its own limit, deliberately not QUEUE_MAX_ATTEMPTS (docs/09 §5.2).
    attempts: () => WEBHOOK_DELIVERY_ATTEMPTS,
    backoff: {
      kind: 'schedule',
      delaysMs: WEBHOOK_BACKOFF_SCHEDULE_MS,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('webhooks.deliver'),
      alarm: 'page',
      consequence:
        'The delivery is marked failed and the endpoint is flagged. It stays visible in ' +
        'the deliveries view and can be replayed (docs/09 §5.4).',
    },
    jobIdKey: 'delivery_id',
    notes:
      'Carries ids only; the worker re-reads the event body, so a stale queue entry ' +
      'cannot leak superseded data.',
  },

  'notifications.email': {
    name: 'notifications.email',
    priority: 'batch',
    tier: 'normal',
    concurrency: (queues) => queues.submitConcurrency,
    concurrencyEnv: 'QUEUE_SUBMIT_CONCURRENCY (shared default; dedicated variable TBD)',
    attempts: (queues) => queues.maxAttempts,
    backoff: {
      kind: 'exponential',
      baseDelayMs: (queues) => queues.backoffMs,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('notifications.email'),
      alarm: 'page',
      consequence: "Visible in the invitation list as 'send failed', for a human to resend.",
    },
    jobIdKey: 'notification_id',
    notes:
      'Never carries a token plaintext; the worker reads the invitation row and renders ' +
      'the link (docs/14).',
  },

  'bank.jobs': {
    name: 'bank.jobs',
    priority: 'batch',
    tier: 'low',
    concurrency: (queues) => queues.submitConcurrency,
    concurrencyEnv: 'QUEUE_SUBMIT_CONCURRENCY (shared default; dedicated variable TBD)',
    attempts: () => BANK_JOB_ATTEMPTS,
    backoff: {
      kind: 'exponential',
      baseDelayMs: (queues) => queues.backoffMs,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('bank.jobs'),
      alarm: 'page',
      consequence: 'The job row records the error list the operator sees. Nothing is half-applied.',
    },
    jobIdKey: 'job_id',
    notes:
      'Each question is imported in its own transaction; skipped rows are reported, ' +
      'never partially written.',
  },

  'maintenance.cron': {
    name: 'maintenance.cron',
    priority: 'batch',
    tier: 'low',
    concurrency: () => MAINTENANCE_CONCURRENCY,
    concurrencyEnv: 'fixed at 1 per job key',
    attempts: () => MAINTENANCE_ATTEMPTS,
    backoff: {
      kind: 'exponential',
      baseDelayMs: (queues) => queues.backoffMs,
      jitterRatio: JITTER_RATIO,
    },
    deadLetter: {
      queue: deadLetterQueueName('maintenance.cron'),
      alarm: 'page',
      consequence:
        'A non-empty DLQ here pages: a silent sweep failure is invisible otherwise, and ' +
        'the deadline sweep is what keeps an attempt from running past its deadline.',
    },
    // job_key:scheduled_for guarantees one run per tick across every worker replica.
    jobIdKey: 'job_key:scheduled_for',
    notes: 'Repeatable-job carrier for every scheduled sweep, so schedules survive a restart.',
  },
};

/** The policy for one queue. Throws for a name that is not one of the six. */
export function queueSpec(name: QueueName): QueueSpec {
  return QUEUES[name];
}

// --- resolving the registry against a live environment ---------------------------

function resolveQueuesConfig(explicit: QueuesConfig | undefined): QueuesConfig {
  return explicit ?? config.queues;
}

/** The worker concurrency for a queue, from its registry entry. */
export function resolveConcurrency(name: QueueName, queues: QueuesConfig): number {
  return QUEUES[name].concurrency(queues);
}

/** The attempt budget for a queue, from its registry entry. */
export function resolveAttempts(name: QueueName, queues: QueuesConfig): number {
  return QUEUES[name].attempts(queues);
}

/**
 * The delay before the next attempt, in milliseconds, with jitter applied.
 *
 * `attemptsMade` counts the attempts already run, so it is 1 when the first attempt has
 * just failed. `random` is a parameter because a backoff that reads `Math.random`
 * directly cannot be tested, and an untested backoff is how a retry storm gets shipped.
 */
export function backoffDelayMs(
  spec: BackoffSpec,
  attemptsMade: number,
  queues: QueuesConfig,
  random: () => number = Math.random,
): number {
  const attempt = Number.isFinite(attemptsMade) && attemptsMade > 0 ? Math.floor(attemptsMade) : 1;

  const nominal =
    spec.kind === 'exponential'
      ? spec.baseDelayMs(queues) * Math.pow(2, attempt - 1)
      : scheduledDelay(spec.delaysMs, attempt);

  return applyJitter(nominal, spec.jitterRatio, random);
}

function scheduledDelay(delaysMs: readonly number[], attempt: number): number {
  if (delaysMs.length === 0) return 0;
  const index = Math.min(attempt - 1, delaysMs.length - 1);
  return delaysMs[index] ?? delaysMs[delaysMs.length - 1] ?? 0;
}

/** Full ±`ratio` jitter. `random() === 0.5` reproduces the nominal delay exactly. */
function applyJitter(nominal: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return Math.max(0, Math.round(nominal));
  const factor = 1 + ratio * (2 * random() - 1);
  return Math.max(0, Math.round(nominal * factor));
}

/**
 * The BullMQ backoff declaration for a queue.
 *
 * An exponential curve is expressed natively — BullMQ 6 applies the jitter itself. A
 * fixed schedule is expressed as a named custom strategy, which {@link createWorker}
 * installs; the `delay` is irrelevant for a custom strategy but must be present.
 */
export function backoffOptions(name: QueueName, queues: QueuesConfig): BackoffOptions {
  const spec = QUEUES[name].backoff;
  if (spec.kind === 'exponential') {
    return { type: 'exponential', delay: spec.baseDelayMs(queues), jitter: spec.jitterRatio };
  }
  return { type: SCHEDULE_BACKOFF_TYPE, delay: spec.delaysMs[0] ?? 0 };
}

/**
 * The default job options for a queue: the attempt budget and the backoff curve from the
 * registry, plus the retention policy.
 *
 * `removeOnFail: false` is the load-bearing line. A failed job is evidence — RB-02's
 * first instruction is to list the affected submission ids, and a queue configured to
 * clean up after itself is a queue that has already destroyed the answer.
 */
export function defaultJobOptions(name: QueueName, queues: QueuesConfig): JobsOptions {
  return {
    attempts: resolveAttempts(name, queues),
    backoff: backoffOptions(name, queues),
    // Completed jobs are kept briefly so an operator can see the last hour of work.
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: false,
  };
}

// --- construction ----------------------------------------------------------------

/** Options common to every queue and worker this module builds. */
export interface ConnectionScopedOptions {
  /** Defaults to the Valkey URL in `VALKEY_URL`/`REDIS_URL` (docs/13 §4.4). */
  readonly connection?: ConnectionOptions | undefined;
  /** Defaults to the parsed environment. A test supplies a fixture instead. */
  readonly queues?: QueuesConfig | undefined;
}

/**
 * Connection options for BullMQ, from configuration.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for its blocking connections: with
 * a finite limit, a Valkey failover aborts the blocking read and the worker stops
 * consuming without saying so.
 */
export function defaultConnection(): ConnectionOptions {
  return { url: config.valkey.url, maxRetriesPerRequest: null };
}

function resolveConnection(explicit: ConnectionOptions | undefined): ConnectionOptions {
  return explicit ?? defaultConnection();
}

/**
 * Builds a producer handle for one of the six queues, carrying that queue's policy as
 * its default job options.
 *
 * A caller adds a job with `{ jobId: <business key> }` and nothing else; everything that
 * governs retries is already attached.
 */
export function createQueue<TData = unknown, TResult = unknown>(
  name: QueueName,
  options: ConnectionScopedOptions = {},
): Queue<TData, TResult, string> {
  const queues = resolveQueuesConfig(options.queues);
  return new Queue<TData, TResult, string>(name, {
    connection: resolveConnection(options.connection),
    defaultJobOptions: defaultJobOptions(name, queues),
  });
}

/**
 * Builds a handle on a dead-letter queue.
 *
 * It has no worker, by design: its depth is the number of jobs waiting for a human, and
 * `attempts: 1` with `removeOnFail: false` means nothing it holds can be lost by
 * retrying or by a retention sweep.
 */
export function createDeadLetterQueue(
  name: QueueName,
  options: ConnectionScopedOptions = {},
): Queue<unknown, void, string> {
  return new Queue<unknown, void, string>(deadLetterQueueName(name), {
    connection: resolveConnection(options.connection),
    defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false },
  });
}

/** A dead-letter sink backed by a real dead-letter queue on Valkey. */
export function createDeadLetterSink(
  name: QueueName,
  options: ConnectionScopedOptions = {},
): DeadLetterSink {
  const queue = createDeadLetterQueue(name, options);
  return {
    async send(envelope): Promise<void> {
      // The job id is the original job's id, so replaying a dead letter that was written
      // twice — a worker restart between the alarm and the write — cannot duplicate it.
      await queue.add(envelope.jobName, envelope, { jobId: envelope.jobId });
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}

/** The processor signature a caller supplies to {@link createWorker}. */
export type JobHandler<TData, TResult> = (job: Job<TData, TResult, string>) => Promise<TResult>;

/** Options for {@link createWorker}. */
export interface CreateWorkerOptions extends ConnectionScopedOptions {
  /** Overrides the registry's concurrency. Used by tests and by a single-job replica. */
  readonly concurrency?: number | undefined;
  /** Defaults to true. False builds the worker without it starting to consume. */
  readonly autorun?: boolean | undefined;
  readonly logger?: Logger | undefined;
  /** Defaults to a sink backed by this queue's dead-letter queue. */
  readonly deadLetter?: DeadLetterSink | undefined;
  /** Injected clock, for the dead-letter envelope's timestamp. */
  readonly now?: (() => Date) | undefined;
  /** Injected randomness, for the custom backoff strategy's jitter. */
  readonly random?: (() => number) | undefined;
}

/**
 * Builds a consumer for one of the six queues, wrapped in everything every job needs and
 * no job should have to remember:
 *
 * - the trace hop — the producer's context is extracted and the handler runs inside a
 *   consumer span parented to it, and a job that arrived without context increments
 *   `bullmq_job_missing_context_total` rather than breaking the trace silently;
 * - the duration histogram and the failure counter, with a bucketed reason label;
 * - the queue-wait histogram, from the job's own enqueue timestamp;
 * - dead-letter routing on the last attempt, with the alarm and the domain consequence
 *   declared in the registry;
 * - the custom backoff strategy, for a queue whose curve is a table rather than a
 *   doubling.
 *
 * The handler itself receives the job and returns a result. It is not responsible for any
 * of the above, which is the point: an instrumentation step a handler has to remember is
 * an instrumentation step that is missing from the handler written at 18:00 on a Friday.
 */
export function createWorker<TData = unknown, TResult = unknown>(
  name: QueueName,
  handler: JobHandler<TData, TResult>,
  options: CreateWorkerOptions = {},
): Worker<TData, TResult, string> {
  const spec = QUEUES[name];
  const queues = resolveQueuesConfig(options.queues);
  const log = options.logger ?? defaultLogger;
  const now = options.now ?? ((): Date => new Date());
  const random = options.random ?? Math.random;
  const connection = resolveConnection(options.connection);
  // A sink built here is owned here, and is released when the worker closes. A caller's
  // sink is the caller's to close: a worker that closed a handle it was lent would break
  // the next worker sharing it.
  const ownsSink = options.deadLetter === undefined;
  const sink = options.deadLetter ?? createDeadLetterSink(name, { connection, queues });
  const maxAttempts = resolveAttempts(name, queues);

  const processor: Processor<TData, TResult, string> = async (job) => {
    const extracted = extractTraceContext(job.data);
    if (!extracted.present) jobMissingContext.inc({ queue: name });

    observeTimeInQueue(name, queueWaitSeconds(job, now()));

    const stopTimer = jobDuration.startTimer({ queue: name, job_name: job.name });

    try {
      const result = await runInJobSpan(
        extracted.context,
        {
          queue: name,
          jobName: job.name,
          jobId: job.id ?? 'unassigned',
          attempt: job.attemptsMade + 1,
        },
        () => handler(job),
      );
      const seconds = stopTimer();
      log.info(
        {
          event: 'job.completed',
          queue: name,
          job_name: job.name,
          job_id: job.id,
          attempt: job.attemptsMade + 1,
          duration_seconds: seconds,
        },
        'job completed',
      );
      return result;
    } catch (err: unknown) {
      stopTimer();
      jobFailed.inc({ queue: name, job_name: job.name, reason: classifyFailure(err) });
      throw err;
    }
  };

  const workerOptions: WorkerOptions = {
    connection,
    concurrency: options.concurrency ?? resolveConcurrency(name, queues),
    autorun: options.autorun ?? true,
    // Failed jobs are never auto-removed: see defaultJobOptions.
    removeOnComplete: { age: 3_600, count: 1_000 },
    settings: {
      backoffStrategy: (attemptsMade: number): number =>
        backoffDelayMs(spec.backoff, attemptsMade, queues, random),
    },
  };

  const worker = new Worker<TData, TResult, string>(name, processor, workerOptions);

  worker.on('failed', (job, err) => {
    // `failed` fires on every attempt. handleJobFailure decides whether this one was the
    // last, and it never throws — an exception here has nowhere to go.
    const traceId = activeTraceId();
    void handleJobFailure({
      queue: name,
      maxAttempts,
      consequence: spec.deadLetter.consequence,
      job:
        job === undefined
          ? undefined
          : { id: job.id, name: job.name, data: job.data, attemptsMade: job.attemptsMade },
      error: err,
      unrecoverable: err instanceof UnrecoverableError,
      sink,
      logger: log,
      ...(traceId === undefined ? {} : { traceId }),
      now,
    });
  });

  worker.on('error', (err) => {
    // A worker-level error is a connection or lock problem, not a job failure. It must
    // be visible: a worker that has stopped consuming looks identical to an idle one.
    log.error({ event: 'worker.error', queue: name, err }, 'worker error');
  });

  worker.on('stalled', (jobId) => {
    log.warn(
      { event: 'job.stalled', queue: name, job_id: jobId },
      'job stalled and was returned to the queue; redelivery is safe because jobs are idempotent',
    );
  });

  // docs/12 §4.1: `bullmq_workers_active == 0` while depth is non-zero pages, because a
  // worker tier that is down looks exactly like one that is idle. The gauge is stepped
  // rather than set, so a replica running two workers on a queue reports two.
  worker.on('closing', () => {
    workersActive.dec({ queue: name });
  });

  worker.on('closed', () => {
    if (!ownsSink) return;
    // Without this the dead-letter queue's connection outlives the worker and the process
    // never exits, which turns a graceful shutdown into a kill after the runtime's grace.
    void sink.close().catch((err: unknown) => {
      log.warn(
        { event: 'worker.dead_letter_close_failed', queue: name, err },
        'the dead-letter queue handle did not close cleanly',
      );
    });
  });

  workersActive.inc({ queue: name });
  return worker;
}

/** How long a job waited before this worker picked it up, in seconds, floored at zero. */
function queueWaitSeconds(job: { readonly timestamp: number }, now: Date): number {
  const waited = (now.getTime() - job.timestamp) / 1000;
  return Number.isFinite(waited) && waited > 0 ? waited : 0;
}
