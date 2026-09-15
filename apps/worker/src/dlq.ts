/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dead-lettering: what happens to a job that has used its last attempt.
 *
 * The rule this module exists to make true (docs/17 §6, CODE-GRAPH `worker` invariants):
 * a job that exhausts its retries **never disappears and never silently scores zero.**
 * It is written to a dead-letter queue with the payload needed to replay it, it
 * increments an alarm metric that pages at any hour, and the domain consequence declared
 * beside the queue in `queues.ts` — the attempt moves to `under_review`, the delivery is
 * marked failed, the invitation shows "send failed" — is what happens instead of a score.
 *
 * The decision is a pure function of the attempt counters, separated from the Redis write
 * deliberately: it is the part that must be right, and it is the part that can be tested
 * without a queue, a clock or a container.
 *
 * `QueueName` is imported here as a type only. The runtime dependency runs the other way
 * — `queues.ts` imports this module — and `verbatimModuleSyntax` erases a type import
 * entirely, so the two files reference each other in the type system without forming a
 * module cycle at run time.
 */

import type { Logger } from '@assaybank/observability';
import { z } from 'zod';

import { classifyFailure, dlqDepth, jobDeadLettered, jobRetried } from './metrics.js';
import { deadLetterQueueName } from './queue-names.js';
import type { DeadLetterQueueName, QueueName } from './queue-names.js';

/**
 * The upper bound on a stored failure reason, in characters.
 *
 * A failure reason is an operator-facing string, but it is produced by whatever threw —
 * and a Postgres error message can contain the parameter values of the failing
 * statement, which for an answer upsert is a candidate's answer. It is truncated here,
 * it never reaches a candidate-scoped response, and a full diagnosis comes from the
 * trace rather than from this field.
 */
export const MAX_FAILED_REASON_CHARS = 512;

/** Why a job was dead-lettered. */
export type DeadLetterReason = 'attempts_exhausted' | 'unrecoverable';

/** What the counters looked like when a job attempt failed. */
export interface DeadLetterDecisionInput {
  /** The queue the job was running on. */
  readonly queue: QueueName;
  /** Attempts already made, counting the one that just failed. BullMQ's `attemptsMade`. */
  readonly attemptsMade: number;
  /** The queue's attempt budget, resolved from its registry entry. */
  readonly maxAttempts: number;
  /**
   * The handler threw `UnrecoverableError`: retrying cannot help, so the remaining
   * budget is not spent pointlessly. A malformed payload is the usual case.
   */
  readonly unrecoverable?: boolean | undefined;
}

/** The outcome of {@link deadLetterDecision}. */
export type DeadLetterDecision =
  | {
      readonly deadLetter: false;
      /** The attempt number BullMQ will run next. */
      readonly nextAttempt: number;
      readonly attemptsRemaining: number;
    }
  | {
      readonly deadLetter: true;
      readonly reason: DeadLetterReason;
      readonly queue: DeadLetterQueueName;
    };

/**
 * Decides whether a failed attempt is the last one.
 *
 * Pure, total and injected with nothing: every input is a number already in hand when
 * the `failed` event fires. `attemptsMade >= maxAttempts` is the whole rule, plus the
 * short circuit for an error that has told us retrying is pointless.
 *
 * A non-positive or non-finite `attemptsMade` is treated as exhausted rather than as a
 * fresh job. The bias is deliberate: over-reporting to the dead-letter queue costs an
 * operator a minute, and under-reporting loses a candidate's submission.
 */
export function deadLetterDecision(input: DeadLetterDecisionInput): DeadLetterDecision {
  const { queue, maxAttempts } = input;

  if (input.unrecoverable === true) {
    return { deadLetter: true, reason: 'unrecoverable', queue: deadLetterQueueName(queue) };
  }

  const attemptsMade = Number.isFinite(input.attemptsMade) ? input.attemptsMade : 0;
  const budget = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;

  if (attemptsMade < 1 || attemptsMade >= budget) {
    return { deadLetter: true, reason: 'attempts_exhausted', queue: deadLetterQueueName(queue) };
  }

  return {
    deadLetter: false,
    nextAttempt: attemptsMade + 1,
    attemptsRemaining: budget - attemptsMade,
  };
}

/**
 * What is written to the dead-letter queue.
 *
 * It carries ids and counters, never content: the payloads on every queue in
 * `code-graph.json` are id-only by design so that a stale queue entry cannot leak
 * superseded data, and re-reading the row at replay time is what makes a twelve-hour-old
 * dead letter safe to retry.
 */
export interface DeadLetterEnvelope {
  readonly queue: QueueName;
  readonly jobId: string;
  readonly jobName: string;
  /** The original job payload, unchanged, so the job can be replayed exactly. */
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly reason: DeadLetterReason;
  /** The bucketed failure class, the same value the `bullmq_job_failed_total` label carries. */
  readonly failureClass: string;
  /** Truncated to {@link MAX_FAILED_REASON_CHARS}. */
  readonly failedReason: string;
  /** RFC 3339, from the injected clock. */
  readonly failedAt: string;
  /** The trace the failure belongs to, so an operator lands on the whole path. */
  readonly traceId?: string | undefined;
  /** The domain consequence declared beside the queue — what happens instead of a score. */
  readonly consequence: string;
}

/**
 * Parses an envelope read back out of Valkey. The dead-letter queue is a boundary: its
 * contents were written by some earlier version of this process, and a replay tool that
 * trusted the shape would be the thing that breaks during an incident.
 */
export const DeadLetterEnvelopeSchema = z.object({
  queue: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().min(1),
  data: z.unknown().optional(),
  attemptsMade: z.number().int().nonnegative(),
  reason: z.enum(['attempts_exhausted', 'unrecoverable']),
  failureClass: z.string().min(1),
  failedReason: z.string(),
  failedAt: z.string().min(1),
  traceId: z.string().optional(),
  consequence: z.string(),
});

/** Inputs to {@link deadLetterEnvelope}. */
export interface DeadLetterEnvelopeInput {
  readonly queue: QueueName;
  readonly jobId: string | undefined;
  readonly jobName: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly reason: DeadLetterReason;
  readonly failureClass: string;
  readonly error: unknown;
  readonly consequence: string;
  readonly traceId?: string | undefined;
  /** Injected clock. docs/17 §8: time is a parameter, never a wall-clock read. */
  readonly now: Date;
}

/** Builds the envelope. Pure, given the clock. */
export function deadLetterEnvelope(input: DeadLetterEnvelopeInput): DeadLetterEnvelope {
  return {
    queue: input.queue,
    jobId: input.jobId ?? `unknown:${input.now.toISOString()}`,
    jobName: input.jobName,
    data: input.data,
    attemptsMade: input.attemptsMade,
    reason: input.reason,
    failureClass: input.failureClass,
    failedReason: truncateReason(input.error),
    failedAt: input.now.toISOString(),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    consequence: input.consequence,
  };
}

/** Renders a thrown value as a bounded operator-facing string. */
export function truncateReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'non-error thrown';
  return raw.length <= MAX_FAILED_REASON_CHARS
    ? raw
    : `${raw.slice(0, MAX_FAILED_REASON_CHARS)}…[truncated]`;
}

/**
 * Where a dead letter is written.
 *
 * An interface rather than a `Queue`, for two reasons: the tests need a sink that does
 * not need Valkey, and `queues.ts` — which owns queue construction — can supply the real
 * one without this module importing it back.
 */
export interface DeadLetterSink {
  send(envelope: DeadLetterEnvelope): Promise<void>;
  close(): Promise<void>;
}

/** A sink that records in memory. The default in tests; never used in a deployed tier. */
export class MemoryDeadLetterSink implements DeadLetterSink {
  private readonly received: DeadLetterEnvelope[] = [];

  public send(envelope: DeadLetterEnvelope): Promise<void> {
    this.received.push(envelope);
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  /** Everything written, oldest first. */
  public get envelopes(): readonly DeadLetterEnvelope[] {
    return this.received;
  }
}

/** The shape of a failed job that {@link handleJobFailure} needs. */
export interface FailedJobFacts {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  readonly attemptsMade: number;
}

/** Inputs to {@link handleJobFailure}. */
export interface JobFailureInput {
  readonly queue: QueueName;
  readonly maxAttempts: number;
  readonly consequence: string;
  readonly job: FailedJobFacts | undefined;
  readonly error: unknown;
  readonly unrecoverable?: boolean | undefined;
  readonly sink: DeadLetterSink;
  readonly logger: Logger;
  readonly traceId?: string | undefined;
  readonly now: () => Date;
}

/**
 * Routes one failed attempt: either it retries, or it becomes a dead letter with an
 * alarm.
 *
 * This never throws. It is called from BullMQ's `failed` event, where an exception has
 * nowhere to go, and a dead-letter write that failed loudly in the logs is recoverable
 * while an unhandled rejection that killed the worker mid-window is not.
 */
export async function handleJobFailure(input: JobFailureInput): Promise<DeadLetterDecision> {
  const { queue, job, error, logger, sink } = input;
  const jobName = job?.name ?? 'unknown';
  const failureClass = classifyFailure(error);

  const decision = deadLetterDecision({
    queue,
    attemptsMade: job?.attemptsMade ?? Number.NaN,
    maxAttempts: input.maxAttempts,
    ...(input.unrecoverable === undefined ? {} : { unrecoverable: input.unrecoverable }),
  });

  if (!decision.deadLetter) {
    jobRetried.inc({
      queue,
      job_name: jobName,
      attempt_no: String(decision.nextAttempt),
    });
    logger.warn(
      {
        event: 'job.retrying',
        queue,
        job_name: jobName,
        job_id: job?.id,
        attempts_made: job?.attemptsMade,
        attempts_remaining: decision.attemptsRemaining,
        reason: failureClass,
        err: error,
      },
      'job attempt failed and will be retried',
    );
    return decision;
  }

  const envelope = deadLetterEnvelope({
    queue,
    jobId: job?.id,
    jobName,
    data: job?.data,
    attemptsMade: job?.attemptsMade ?? 0,
    reason: decision.reason,
    failureClass,
    error,
    consequence: input.consequence,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    now: input.now(),
  });

  // The alarm first, the write second. If Valkey is the thing that is broken, the
  // counter is still the signal that something needed a human, and RB-02 starts from
  // the alert rather than from the queue.
  jobDeadLettered.inc({ queue, job_name: jobName, reason: failureClass });
  dlqDepth.inc({ queue });

  try {
    await sink.send(envelope);
    logger.error(
      {
        event: 'job.dead_lettered',
        queue,
        dlq: decision.queue,
        job_name: jobName,
        job_id: envelope.jobId,
        attempts_made: envelope.attemptsMade,
        reason: failureClass,
        dead_letter_reason: decision.reason,
        consequence: input.consequence,
        err: error,
      },
      'job exhausted its attempts and was dead-lettered',
    );
  } catch (sinkError: unknown) {
    logger.fatal(
      {
        event: 'job.dead_letter_write_failed',
        queue,
        dlq: decision.queue,
        job_name: jobName,
        job_id: envelope.jobId,
        consequence: input.consequence,
        err: sinkError,
      },
      'a dead letter could not be written; the job is recorded only in this log line',
    );
  }

  return decision;
}
