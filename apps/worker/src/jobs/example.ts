/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-op example job: the full lifecycle of a job in this system, with the domain
 * removed.
 *
 * It exists because P0 has no domain to grade, and a queue whose first real job is
 * written in P2 is a queue whose enqueue path, trace hop, retry policy, dead-letter
 * routing and metric labels are all first exercised in P2 — by which point they are
 * being debugged at the same time as the grading code that depends on them. This job is
 * enqueued once at boot and proves the whole path end to end.
 *
 * It is also the worked example of the three rules every job in this repository follows,
 * which are easier to copy than to remember:
 *
 * 1. **Parse the payload at the edge.** `job.data` came out of Valkey. It is `unknown`
 *    until a schema says otherwise, whatever the enqueue site believed it wrote.
 * 2. **Be idempotent by a business key.** At-least-once delivery means a redelivery is
 *    normal traffic. The key here is the tick; for grading it is the submission id
 *    (ADR-008); for a webhook it is the delivery id.
 * 3. **Return a result, never a side effect nobody can see.** The result is what a
 *    replay returns, so it is what makes a replayed job indistinguishable from the first
 *    run.
 *
 * Delete it when the first real job lands on `maintenance.cron`.
 */

import type { Logger } from '@assaybank/observability';
import { z } from 'zod';

import { idempotent } from '../idempotency.js';
import type { IdempotencyStore } from '../idempotency.js';

/** The job name. One of the values `bullmq_job_duration_seconds`'s `job_name` label takes. */
export const EXAMPLE_JOB_NAME = 'example.noop';

/**
 * The payload.
 *
 * `tick` is the instant the job was enqueued for, which is what makes the business key
 * unique per enqueue and stable across a redelivery of the same enqueue. A job payload
 * carries identifiers and instants, never content (`code-graph.json`, every queue).
 */
export const ExampleJobPayloadSchema = z.object({
  tick: z.iso.datetime({ offset: true }),
});

/** The parsed payload. */
export type ExampleJobPayload = z.infer<typeof ExampleJobPayloadSchema>;

/** What the job returns, and therefore what a replay of it returns. */
export interface ExampleJobResult {
  readonly job: typeof EXAMPLE_JOB_NAME;
  readonly tick: string;
  /** RFC 3339. On a replay this is the *first* run's instant, which is the point. */
  readonly completedAt: string;
}

const ExampleJobResultSchema = z.object({
  job: z.literal(EXAMPLE_JOB_NAME),
  tick: z.string().min(1),
  completedAt: z.string().min(1),
});

/**
 * The business key. `example.noop:<tick>` — the job name and the thing that identifies
 * this unit of work, which is the shape every key in this system takes.
 */
export function exampleJobKey(payload: ExampleJobPayload): string {
  return `${EXAMPLE_JOB_NAME}:${payload.tick}`;
}

/** Builds a payload for an enqueue at `now`. */
export function exampleJobPayload(now: Date): ExampleJobPayload {
  return { tick: now.toISOString() };
}

/** Everything the job needs from its surroundings, all injected. */
export interface ExampleJobDeps {
  readonly logger: Logger;
  /** docs/17 §8: time is a parameter. A job that reads the wall clock cannot be tested. */
  readonly now: () => Date;
  /** Defaults to the process-wide store. */
  readonly store?: IdempotencyStore | undefined;
}

/**
 * Runs the example job.
 *
 * `raw` is `job.data`, unparsed. A malformed payload throws a `ZodError`, which
 * `classifyFailure` buckets as `validation` and which the queue's attempt budget then
 * spends — correctly, because a payload that is malformed once is malformed on every
 * attempt, and the dead-letter queue is where it belongs.
 */
export async function runExampleJob(raw: unknown, deps: ExampleJobDeps): Promise<ExampleJobResult> {
  const payload = ExampleJobPayloadSchema.parse(raw);
  const key = exampleJobKey(payload);

  return idempotent<ExampleJobResult>(
    key,
    () => {
      const result: ExampleJobResult = {
        job: EXAMPLE_JOB_NAME,
        tick: payload.tick,
        completedAt: deps.now().toISOString(),
      };

      deps.logger.info(
        {
          event: 'job.example.ran',
          job_name: EXAMPLE_JOB_NAME,
          tick: payload.tick,
          idempotency_key: key,
        },
        'example job did nothing, successfully',
      );

      return Promise.resolve(result);
    },
    {
      queue: 'maintenance.cron',
      ...(deps.store === undefined ? {} : { store: deps.store }),
      // The recorded result made a round trip through JSON, so it is parsed on the way
      // back rather than asserted. This is the half of the idempotency contract that is
      // easy to skip and is the reason a replayed job can be trusted.
      decode: (value: unknown): ExampleJobResult => ExampleJobResultSchema.parse(value),
    },
  );
}
