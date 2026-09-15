/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The queue-depth sampler.
 *
 * docs/17 §6: "Every queue ships with a depth metric and an alarm in the same pull
 * request that creates it. A queue without a depth metric will back up unnoticed during
 * the one hour it matters." Depth is not something a worker observes as a side effect of
 * working — a worker that has stopped consuming reports nothing at all — so it is polled.
 *
 * Three numbers per queue, and the third is the one people forget:
 *
 * - `bullmq_queue_depth`, waiting and delayed. The backlog.
 * - `bullmq_dlq_depth`. Every unit is a job waiting for a human (RB-02).
 * - `bullmq_oldest_job_age_seconds`. **Depth alone lies about a stalled queue**
 *   (docs/12 §11): a queue that is neither growing nor draining has a flat depth and a
 *   rising head age, and only the second of those says anything is wrong.
 *
 * The probe is an interface rather than a `Queue` so the sampling logic can be tested
 * without Valkey — which is the whole of its behaviour worth testing, since the arithmetic
 * is where a wrong unit or an inverted sign would hide.
 *
 * Cost, stated rather than discovered: the default sampler holds twelve queue handles —
 * six queues and six dead-letter queues — and BullMQ opens a connection per handle. That
 * is the documented pattern and it is fine at the replica counts this system runs at. If
 * it ever stops being fine, the fix is to pass one shared client through
 * {@link ConnectionScopedOptions}; it is not built now because there is no second
 * consumer for it and P0 does not build abstractions for imagined futures.
 */

import type { Logger } from '@assaybank/observability';

import { recordDeadLetterDepth, recordOldestJobAge, recordQueueDepth } from './metrics.js';
import { QUEUE_NAMES } from './queue-names.js';
import type { QueueName } from './queue-names.js';
import { createDeadLetterQueue, createQueue } from './queues.js';
import type { ConnectionScopedOptions } from './queues.js';

/** How often depth is sampled, in milliseconds. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;

/** One queue's observable state, as the sampler needs it. */
export interface DepthProbe {
  readonly queue: QueueName;
  counts(): Promise<{ readonly waiting: number; readonly delayed: number }>;
  /** Epoch milliseconds of the oldest waiting job, or `undefined` when the queue is empty. */
  oldestJobTimestamp(): Promise<number | undefined>;
  deadLetterDepth(): Promise<number>;
}

/**
 * Samples every probe once and records the result.
 *
 * A probe that throws is logged and skipped rather than failing the pass: Valkey being
 * briefly unreachable must not take down the process whose job is to keep reporting once
 * Valkey comes back, and the gap in the series is itself the signal.
 */
export async function sampleOnce(
  probes: readonly DepthProbe[],
  now: () => Date,
  logger: Logger,
): Promise<void> {
  const at = now().getTime();

  await Promise.all(
    probes.map(async (probe) => {
      try {
        const [counts, oldest, dlq] = await Promise.all([
          probe.counts(),
          probe.oldestJobTimestamp(),
          probe.deadLetterDepth(),
        ]);

        recordQueueDepth(probe.queue, counts);
        recordDeadLetterDepth(probe.queue, dlq);
        recordOldestJobAge(probe.queue, oldest === undefined ? 0 : ageSeconds(oldest, at));
      } catch (err: unknown) {
        logger.warn(
          { event: 'queue.sample_failed', queue: probe.queue, err },
          'queue depth sample failed; the gap in the series is the signal',
        );
      }
    }),
  );
}

/** Age in seconds, floored at zero — a clock skew must not produce a negative gauge. */
function ageSeconds(timestampMs: number, nowMs: number): number {
  const age = (nowMs - timestampMs) / 1000;
  return Number.isFinite(age) && age > 0 ? age : 0;
}

/** A running sampler. */
export interface RunningSampler {
  /** Runs one pass immediately. Used by tests and by the first pass at boot. */
  sample(): Promise<void>;
  stop(): Promise<void>;
}

/** Options for {@link startDepthSampler}. */
export interface StartSamplerOptions extends ConnectionScopedOptions {
  readonly logger: Logger;
  readonly intervalMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Supplied by tests. When absent, one probe per canonical queue is built from Valkey. */
  readonly probes?: readonly DepthProbe[] | undefined;
}

/**
 * Builds a probe per canonical queue, backed by real queue handles, and polls them.
 *
 * The handles are producer-side only: reading a count does not consume anything, and the
 * sampler never touches a job.
 */
export function startDepthSampler(options: StartSamplerOptions): RunningSampler {
  const now = options.now ?? ((): Date => new Date());
  const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  const owned: Array<{ close(): Promise<void> }> = [];
  const probes =
    options.probes ??
    QUEUE_NAMES.map((name) => {
      const scope: ConnectionScopedOptions = {
        ...(options.connection === undefined ? {} : { connection: options.connection }),
        ...(options.queues === undefined ? {} : { queues: options.queues }),
      };
      const queue = createQueue(name, scope);
      const dlq = createDeadLetterQueue(name, scope);
      owned.push(queue, dlq);
      return queueProbe(name, queue, dlq);
    });

  const sample = (): Promise<void> => sampleOnce(probes, now, options.logger);

  const timer = setInterval(() => {
    void sample();
  }, intervalMs);
  // The sampler must never be the reason the process stays alive during a shutdown.
  timer.unref();

  return {
    sample,
    async stop(): Promise<void> {
      clearInterval(timer);
      await Promise.all(owned.map((handle) => handle.close()));
    },
  };
}

/** The subset of a BullMQ queue handle the sampler reads. */
export interface CountableQueue {
  getWaiting(start?: number, end?: number): Promise<ReadonlyArray<{ timestamp: number }>>;
  getWaitingCount(): Promise<number>;
  getDelayedCount(): Promise<number>;
}

/** Wraps a pair of real queue handles as a {@link DepthProbe}. */
export function queueProbe(
  name: QueueName,
  queue: CountableQueue,
  deadLetterQueue: Pick<CountableQueue, 'getWaitingCount'>,
): DepthProbe {
  return {
    queue: name,
    async counts(): Promise<{ waiting: number; delayed: number }> {
      const [waiting, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getDelayedCount(),
      ]);
      return { waiting, delayed };
    },
    async oldestJobTimestamp(): Promise<number | undefined> {
      // The head of the waiting list. One element, because the age of the head is the
      // whole question and reading the list would be a scan of the backlog.
      const head = await queue.getWaiting(0, 0);
      return head[0]?.timestamp;
    },
    deadLetterDepth(): Promise<number> {
      // A dead-letter queue has no consumer, so everything it holds is waiting.
      return deadLetterQueue.getWaitingCount();
    },
  };
}
