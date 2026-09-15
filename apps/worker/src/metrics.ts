/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The worker's metrics, declared once at module scope on the shared registry from
 * `@assaybank/observability`.
 *
 * Every name, label set and unit here is fixed by docs/12 §4.1. Three of them carry
 * alerts that page at any hour (docs/12 §12): `bullmq_dlq_depth > 0`,
 * `bullmq_workers_active == 0` while depth is non-zero, and `bullmq_queue_depth` rising
 * monotonically during an exam window. Renaming one silently disarms its alert, which is
 * why the names are constants and the tests assert them.
 *
 * Every label set is closed, and it is closed *here* rather than by convention: the
 * `gauge`/`counter`/`histogram` helpers fold an undeclared value to `other` and refuse a
 * forbidden label name at construction, so an `attempt_id` label is a failed boot rather
 * than a Prometheus instance that falls over at peak (docs/12 §6). The label guard is
 * the reason this module declares metrics through the wrapper and never through
 * `prom-client` directly.
 */

import { counter, gauge, histogram, UNKNOWN } from '@assaybank/observability';
import type { CounterMetric, GaugeMetric, HistogramMetric } from '@assaybank/observability';

import { QUEUE_NAMES, QUEUE_PRIORITY } from './queue-names.js';
import type { QueueName, QueuePriority } from './queue-names.js';

/** The `queue` label's closed value set: the six canonical names and nothing else. */
const QUEUE_LABEL_VALUES: readonly string[] = QUEUE_NAMES;

/** The `priority` label's closed value set (docs/12 §4.1). */
const PRIORITY_LABEL_VALUES: readonly string[] = ['interactive', 'batch'];

/**
 * The `state` label on `bullmq_queue_depth`. Deliberately only the two states that mean
 * "work not yet done": `active` is capacity in use rather than backlog, and `completed`
 * and `failed` are counted elsewhere.
 */
const STATE_LABEL_VALUES: readonly string[] = ['waiting', 'delayed'];

/**
 * Every job name this worker can process, which is what makes `job_name` a legal label.
 *
 * docs/12 §6: "if you cannot write down every possible value, it is not a label." This
 * is that list. A name outside it is folded to `other` by the helper rather than
 * creating a series, and `metrics.test.ts` asserts that the scheduled-job registry
 * stays a subset of it, so adding a sweep without adding it here fails a test rather
 * than quietly losing its panel.
 */
export const KNOWN_JOB_NAMES = [
  'example.noop',
  'deadline-sweep',
  'question-stats',
  'retention-erasure',
  'webhook-reaper',
  'proctor-media-deletion',
  'partition-roll',
] as const;

/** The closed set of failure reasons on `bullmq_job_failed_total` (docs/12 §4.1). */
export const FAILURE_REASONS = [
  'exec_unavailable',
  'timeout',
  'db_error',
  'validation',
  'unknown',
] as const;

/** Why a job threw, bucketed into a label-safe closed set. */
export type FailureReason = (typeof FAILURE_REASONS)[number];

const JOB_NAME_LABEL_VALUES: readonly string[] = KNOWN_JOB_NAMES;
const REASON_LABEL_VALUES: readonly string[] = FAILURE_REASONS;

/**
 * Backlog: jobs waiting or delayed, per queue.
 *
 * docs/12 §4.1 calls this "the single most important number during an exam window", and
 * `project/RISKS.md` R-01 names it directly, so the name is fixed in three places.
 */
export const queueDepth: GaugeMetric<'queue' | 'priority' | 'state'> = gauge({
  name: 'bullmq_queue_depth',
  help: 'Jobs waiting or delayed on a queue. The backlog, per queue and latency class.',
  labelNames: ['queue', 'priority', 'state'],
  labelValues: {
    queue: QUEUE_LABEL_VALUES,
    priority: PRIORITY_LABEL_VALUES,
    state: STATE_LABEL_VALUES,
  },
});

/**
 * How long a job waited before a worker picked it up.
 *
 * Read beside {@link jobDuration} and never alone: queue time rising with flat job
 * duration means add capacity, job duration rising with flat queue time means slow work,
 * and the fix for each is the opposite of the other (docs/12 §11).
 */
export const timeInQueue: HistogramMetric<'queue' | 'priority'> = histogram({
  name: 'bullmq_time_in_queue_seconds',
  help: 'Seconds between a job being enqueued and a worker starting it.',
  labelNames: ['queue', 'priority'],
  labelValues: { queue: QUEUE_LABEL_VALUES, priority: PRIORITY_LABEL_VALUES },
  buckets: [0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 300],
});

/** How long the work itself took, once started. */
export const jobDuration: HistogramMetric<'queue' | 'job_name'> = histogram({
  name: 'bullmq_job_duration_seconds',
  help: 'Seconds a job spent executing, excluding the time it waited in the queue.',
  labelNames: ['queue', 'job_name'],
  labelValues: { queue: QUEUE_LABEL_VALUES, job_name: JOB_NAME_LABEL_VALUES },
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
});

/** Jobs that threw. A retried job is counted on every attempt, not once. */
export const jobFailed: CounterMetric<'queue' | 'job_name' | 'reason'> = counter({
  name: 'bullmq_job_failed_total',
  help: 'Job attempts that threw, by queue, job name and bucketed reason.',
  labelNames: ['queue', 'job_name', 'reason'],
  labelValues: {
    queue: QUEUE_LABEL_VALUES,
    job_name: JOB_NAME_LABEL_VALUES,
    reason: REASON_LABEL_VALUES,
  },
});

/**
 * Whether the attempt budget is being consumed. A job at `attempt_no=3` on a queue whose
 * limit is 3 is one failure away from the dead-letter queue.
 *
 * `attempt_no` is bounded by the attempt limit — at most 20, by the `QUEUE_MAX_ATTEMPTS`
 * range in docs/13 §4.7 — so it is a legal label despite looking like a counter.
 */
export const jobRetried: CounterMetric<'queue' | 'job_name' | 'attempt_no'> = counter({
  name: 'bullmq_job_retried_total',
  help: 'Job attempts that failed and will be retried, labelled with the attempt number.',
  labelNames: ['queue', 'job_name', 'attempt_no'],
  labelValues: { queue: QUEUE_LABEL_VALUES, job_name: JOB_NAME_LABEL_VALUES },
});

/**
 * Jobs that exhausted their retries and now sit in a dead-letter queue.
 *
 * docs/12 §4.1: **every unit is an ungraded submission and a candidate waiting.** The
 * `DeadLetterQueueNonEmpty` alert fires on `> 0` for two minutes and pages at any hour,
 * because delay here destroys candidate work.
 *
 * Two writers, deliberately. `dlq.ts` steps it up the instant a job is dead-lettered, so
 * the alert can fire inside the two-minute window rather than waiting on the next sample;
 * the depth sampler then `set`s it from the queue itself, which is authoritative and
 * corrects the step if the write that followed it never landed. A gauge polled every
 * fifteen seconds is not an alarm on its own.
 */
export const dlqDepth: GaugeMetric<'queue'> = gauge({
  name: 'bullmq_dlq_depth',
  help: 'Jobs sitting in a dead-letter queue after exhausting their attempt budget.',
  labelNames: ['queue'],
  labelValues: { queue: QUEUE_LABEL_VALUES },
});

/**
 * The alarm counter that fires the instant a job is dead-lettered, before the next depth
 * sample. A gauge sampled every fifteen seconds is not an alarm; a counter is.
 */
export const jobDeadLettered: CounterMetric<'queue' | 'job_name' | 'reason'> = counter({
  name: 'bullmq_job_dead_lettered_total',
  help: 'Jobs moved to a dead-letter queue. Each one needs a human (docs/12 RB-02).',
  labelNames: ['queue', 'job_name', 'reason'],
  labelValues: {
    queue: QUEUE_LABEL_VALUES,
    job_name: JOB_NAME_LABEL_VALUES,
    reason: REASON_LABEL_VALUES,
  },
});

/** Live consumers. Zero with non-zero depth means the worker tier is down, not busy. */
export const workersActive: GaugeMetric<'queue'> = gauge({
  name: 'bullmq_workers_active',
  help: 'Workers this process has running against a queue.',
  labelNames: ['queue'],
  labelValues: { queue: QUEUE_LABEL_VALUES },
});

/** Age of the head of the queue. Catches a stalled queue that a flat depth hides. */
export const oldestJobAge: GaugeMetric<'queue'> = gauge({
  name: 'bullmq_oldest_job_age_seconds',
  help: 'Age of the oldest waiting job. A stalled queue hides behind a flat depth.',
  labelNames: ['queue'],
  labelValues: { queue: QUEUE_LABEL_VALUES },
});

/**
 * Jobs that arrived without a `_otel` carrier and therefore started a new trace instead
 * of continuing the candidate's (docs/12 §5.2 rule 3). Silent trace breakage is the
 * failure this metric exists to catch: nothing else goes wrong, and "why did this
 * candidate's score differ on re-grade" quietly becomes unanswerable.
 */
export const jobMissingContext: CounterMetric<'queue'> = counter({
  name: 'bullmq_job_missing_context_total',
  help: 'Jobs delivered without W3C trace context, which breaks the trace at the queue hop.',
  labelNames: ['queue'],
  labelValues: { queue: QUEUE_LABEL_VALUES },
});

/**
 * Jobs whose business key had already been recorded, so the effect was not repeated.
 *
 * At-least-once delivery makes replay normal traffic rather than an incident
 * (docs/09 §5.1), so this is expected to be non-zero. A sudden spike means something
 * upstream is re-enqueueing.
 */
export const idempotentReplay: CounterMetric<'queue' | 'outcome'> = counter({
  name: 'bullmq_job_idempotent_replay_total',
  help: 'Idempotency-key lookups, by whether the effect ran or a recorded result was returned.',
  labelNames: ['queue', 'outcome'],
  labelValues: { queue: QUEUE_LABEL_VALUES, outcome: ['executed', 'replayed'] },
});

/** Records a queue's backlog. Called by the depth sampler, which is the authority. */
export function recordQueueDepth(
  queue: QueueName,
  counts: { readonly waiting: number; readonly delayed: number },
): void {
  const priority: QueuePriority = QUEUE_PRIORITY[queue];
  queueDepth.set({ queue, priority, state: 'waiting' }, counts.waiting);
  queueDepth.set({ queue, priority, state: 'delayed' }, counts.delayed);
}

/** Records the depth of one dead-letter queue, sampled from the queue itself. */
export function recordDeadLetterDepth(queue: QueueName, depth: number): void {
  dlqDepth.set({ queue }, depth);
}

/** Records the age of the head of a queue, in seconds. */
export function recordOldestJobAge(queue: QueueName, seconds: number): void {
  oldestJobAge.set({ queue }, seconds);
}

/** Observes the wait a job endured before this worker started it. */
export function observeTimeInQueue(queue: QueueName, seconds: number): void {
  timeInQueue.observe({ queue, priority: QUEUE_PRIORITY[queue] }, seconds);
}

/**
 * Buckets a thrown value into the closed `reason` label set.
 *
 * It inspects the message only to choose a bucket; the message itself never becomes a
 * label value. A Postgres error's message can contain the parameter values of the
 * failing statement, which for an answer upsert is the candidate's answer — so it
 * belongs on a redacted log line and in a trace, never on a metric (docs/12 §6).
 */
export function classifyFailure(err: unknown): FailureReason {
  if (!(err instanceof Error)) return 'unknown';

  const name = err.name.toLowerCase();
  const message = err.message.toLowerCase();
  const code = readErrorCode(err);
  const haystack = `${name} ${message} ${code}`;

  if (name === 'zoderror' || haystack.includes('validation') || haystack.includes('invalid')) {
    return 'validation';
  }
  if (
    name === 'aborterror' ||
    name === 'timeouterror' ||
    haystack.includes('timeout') ||
    haystack.includes('etimedout')
  ) {
    return 'timeout';
  }
  if (
    haystack.includes('econnrefused') ||
    haystack.includes('enotfound') ||
    haystack.includes('eai_again') ||
    haystack.includes('piston') ||
    haystack.includes('exec')
  ) {
    return 'exec_unavailable';
  }
  if (
    haystack.includes('postgres') ||
    haystack.includes('database') ||
    haystack.includes('deadlock') ||
    haystack.includes('constraint') ||
    haystack.includes('econnreset')
  ) {
    return 'db_error';
  }
  return 'unknown';
}

/**
 * Reads a Node system error's `code` without widening the value to `any`. Errors cross
 * a boundary the type system does not cover, so the property is narrowed rather than
 * asserted.
 */
function readErrorCode(err: Error): string {
  const candidate: unknown = Reflect.get(err, 'code');
  return typeof candidate === 'string' ? candidate.toLowerCase() : '';
}

/**
 * The placeholder the metric helpers use for a label the caller did not supply,
 * re-exported so callers can name it rather than spelling `'unknown'` twice.
 */
export const UNKNOWN_LABEL: string = UNKNOWN;
