/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry's tests. None of them needs Valkey: the registry is a value, and the
 * arithmetic that decides how long a retry waits is a pure function of it.
 *
 * The test that matters most is the one comparing `QUEUE_NAMES` to `code-graph.json`.
 * The queue names are referenced from a Prometheus label set, an alert rule, a dashboard
 * panel and four runbook steps; the graph is the document that ties those together, and
 * a rename that updates the code but not the graph is a rename that silently disarms an
 * alert.
 */

import type { QueuesConfig } from '@assaybank/config';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BANK_JOB_ATTEMPTS,
  DEAD_LETTER_QUEUE_NAMES,
  backoffDelayMs,
  backoffOptions,
  deadLetterQueueName,
  defaultJobOptions,
  GRADING_RUN_MAX_ATTEMPTS,
  isQueueName,
  JITTER_RATIO,
  MAINTENANCE_ATTEMPTS,
  MAINTENANCE_CONCURRENCY,
  QUEUE_NAMES,
  QUEUE_PRIORITY,
  QUEUES,
  queueSpec,
  resolveAttempts,
  resolveConcurrency,
  SCHEDULE_BACKOFF_TYPE,
  WEBHOOK_BACKOFF_SCHEDULE_MS,
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_WINDOW_MS,
} from './queues.js';
import type { QueueName } from './queues.js';

/** The values docs/13 §4.7 gives as defaults, so the assertions below read as the doc does. */
const QUEUES_CONFIG: QueuesConfig = {
  runConcurrency: 4,
  submitConcurrency: 2,
  maxAttempts: 3,
  backoffMs: 2_000,
};

const CodeGraphSchema = z.object({
  queues: z.array(z.object({ name: z.string() })),
});

function codeGraphQueueNames(): string[] {
  const raw = readFileSync(new URL('../../../code-graph.json', import.meta.url), 'utf8');
  return CodeGraphSchema.parse(JSON.parse(raw)).queues.map((queue) => queue.name);
}

describe('the six canonical queues', () => {
  it('are exactly the queues code-graph.json declares', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(codeGraphQueueNames().sort());
  });

  it('has a registry entry for every name, keyed by its own name', () => {
    expect(Object.keys(QUEUES).sort()).toEqual([...QUEUE_NAMES].sort());
    for (const name of QUEUE_NAMES) {
      expect(QUEUES[name].name).toBe(name);
      expect(queueSpec(name)).toBe(QUEUES[name]);
    }
  });

  it('narrows a string to a queue name', () => {
    expect(isQueueName('grading.submit')).toBe(true);
    expect(isQueueName('grading.submit.dlq')).toBe(false);
    expect(isQueueName('grading')).toBe(false);
    expect(isQueueName(42)).toBe(false);
  });

  it('marks only grading.run as interactive — the only queue a human waits on', () => {
    expect(QUEUE_PRIORITY['grading.run']).toBe('interactive');
    const batch = QUEUE_NAMES.filter((name) => QUEUE_PRIORITY[name] === 'batch');
    expect(batch).toHaveLength(5);
  });
});

describe('concurrency', () => {
  it('resolves every queue from the variable its registry entry names', () => {
    const expected: ReadonlyArray<readonly [QueueName, number]> = [
      ['grading.run', 4],
      ['grading.submit', 2],
      ['webhooks.deliver', 2],
      ['notifications.email', 2],
      ['bank.jobs', 2],
      ['maintenance.cron', MAINTENANCE_CONCURRENCY],
    ];
    for (const [name, concurrency] of expected) {
      expect([name, resolveConcurrency(name, QUEUES_CONFIG)]).toEqual([name, concurrency]);
    }
  });

  it('gives grading.run its own variable, so the interactive queue scales separately', () => {
    const wide: QueuesConfig = { ...QUEUES_CONFIG, runConcurrency: 32 };
    expect(resolveConcurrency('grading.run', wide)).toBe(32);
    expect(resolveConcurrency('grading.submit', wide)).toBe(2);
  });

  it('fixes maintenance.cron at one, whatever the environment says', () => {
    const wide: QueuesConfig = { ...QUEUES_CONFIG, submitConcurrency: 64, runConcurrency: 64 };
    expect(resolveConcurrency('maintenance.cron', wide)).toBe(1);
  });
});

describe('attempt limits', () => {
  it('resolves every queue to the budget its registry entry declares', () => {
    const expected: ReadonlyArray<readonly [QueueName, number]> = [
      ['grading.run', GRADING_RUN_MAX_ATTEMPTS],
      ['grading.submit', 3],
      ['webhooks.deliver', WEBHOOK_DELIVERY_ATTEMPTS],
      ['notifications.email', 3],
      ['bank.jobs', BANK_JOB_ATTEMPTS],
      ['maintenance.cron', MAINTENANCE_ATTEMPTS],
    ];
    for (const [name, attempts] of expected) {
      expect([name, resolveAttempts(name, QUEUES_CONFIG)]).toEqual([name, attempts]);
    }
  });

  it('gives webhooks.deliver its own limit of 8, independent of QUEUE_MAX_ATTEMPTS', () => {
    // docs/09 §5.2: a grading job and a webhook delivery have different retry economics,
    // so the webhook limit does not move when the global one does.
    for (const maxAttempts of [1, 3, 20]) {
      const queues: QueuesConfig = { ...QUEUES_CONFIG, maxAttempts };
      expect(resolveAttempts('webhooks.deliver', queues)).toBe(8);
      expect(resolveAttempts('grading.submit', queues)).toBe(maxAttempts);
    }
  });

  it('caps grading.run at two however high QUEUE_MAX_ATTEMPTS is set', () => {
    const generous: QueuesConfig = { ...QUEUES_CONFIG, maxAttempts: 20 };
    expect(resolveAttempts('grading.run', generous)).toBe(2);
  });

  it('never exceeds QUEUE_MAX_ATTEMPTS on grading.run when it is set below the cap', () => {
    const tight: QueuesConfig = { ...QUEUES_CONFIG, maxAttempts: 1 };
    expect(resolveAttempts('grading.run', tight)).toBe(1);
  });

  it('gives every queue at least one attempt', () => {
    for (const name of QUEUE_NAMES) {
      expect(resolveAttempts(name, QUEUES_CONFIG)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('dead-letter policy', () => {
  it('derives every dead-letter queue name from its queue', () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUES[name].deadLetter.queue).toBe(`${name}.dlq`);
      expect(deadLetterQueueName(name)).toBe(`${name}.dlq`);
    }
    expect(DEAD_LETTER_QUEUE_NAMES).toHaveLength(QUEUE_NAMES.length);
  });

  it('pages for every queue, because a dead letter is always someone waiting', () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUES[name].deadLetter.alarm).toBe('page');
      expect(QUEUES[name].deadLetter.consequence.length).toBeGreaterThan(20);
    }
  });

  it('declares a business key per queue, which is what makes a replay a no-op', () => {
    expect(QUEUES['grading.submit'].jobIdKey).toBe('submission_id');
    expect(QUEUES['grading.run'].jobIdKey).toBe('submission_id');
    expect(QUEUES['webhooks.deliver'].jobIdKey).toBe('delivery_id');
    expect(QUEUES['maintenance.cron'].jobIdKey).toBe('job_key:scheduled_for');
    for (const name of QUEUE_NAMES) {
      expect(QUEUES[name].jobIdKey.length).toBeGreaterThan(0);
    }
  });

  it('never removes a failed job: the dead letter is the only record of who was affected', () => {
    for (const name of QUEUE_NAMES) {
      expect(defaultJobOptions(name, QUEUES_CONFIG).removeOnFail).toBe(false);
    }
  });

  it('attaches the registry attempt limit and backoff to every job by default', () => {
    const options = defaultJobOptions('grading.submit', QUEUES_CONFIG);
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 2_000, jitter: JITTER_RATIO });
  });
});

describe('the webhook retry curve', () => {
  it('has one delay fewer than it has attempts — the first attempt is immediate', () => {
    expect(WEBHOOK_BACKOFF_SCHEDULE_MS).toHaveLength(WEBHOOK_DELIVERY_ATTEMPTS - 1);
  });

  it('matches the published table in docs/09 §5.2', () => {
    expect(WEBHOOK_BACKOFF_SCHEDULE_MS).toEqual([
      10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
    ]);
  });

  it('increases monotonically', () => {
    for (let i = 1; i < WEBHOOK_BACKOFF_SCHEDULE_MS.length; i += 1) {
      const current = WEBHOOK_BACKOFF_SCHEDULE_MS[i] ?? 0;
      const previous = WEBHOOK_BACKOFF_SCHEDULE_MS[i - 1] ?? 0;
      expect(current).toBeGreaterThan(previous);
    }
  });

  it('reaches its eighth attempt about 20.6 hours in, as docs/09 §5.2 publishes', () => {
    const nominal = WEBHOOK_BACKOFF_SCHEDULE_MS.reduce((total, delay) => total + delay, 0);
    expect(nominal).toBeLessThan(WEBHOOK_RETRY_WINDOW_MS);
    expect(nominal / 3_600_000).toBeCloseTo(20.6, 1);
  });

  it('can overrun the window once jittered, which is why the reaper enforces the ceiling', () => {
    // The curve is nominal and the jitter is deliberately unbounded within its ratio, so
    // the eighth attempt can fall past 24 hours. The 24-hour limit is therefore enforced
    // by the `webhook-reaper` sweep, which closes out a delivery whose window has
    // expired, rather than by the backoff arithmetic — a delay table that also had to
    // guarantee a deadline would have to shrink the useful retries to do it.
    const worstCase = WEBHOOK_BACKOFF_SCHEDULE_MS.reduce(
      (total, delay) => total + delay * (1 + JITTER_RATIO),
      0,
    );
    expect(worstCase).toBeGreaterThan(WEBHOOK_RETRY_WINDOW_MS);
  });
});

describe('backoffDelayMs', () => {
  const noJitter = (): number => 0.5;

  it('doubles an exponential curve from the configured base', () => {
    const spec = QUEUES['grading.submit'].backoff;
    expect(backoffDelayMs(spec, 1, QUEUES_CONFIG, noJitter)).toBe(2_000);
    expect(backoffDelayMs(spec, 2, QUEUES_CONFIG, noJitter)).toBe(4_000);
    expect(backoffDelayMs(spec, 3, QUEUES_CONFIG, noJitter)).toBe(8_000);
  });

  it('walks the fixed schedule for webhooks, and repeats the last delay past its end', () => {
    const spec = QUEUES['webhooks.deliver'].backoff;
    expect(backoffDelayMs(spec, 1, QUEUES_CONFIG, noJitter)).toBe(10_000);
    expect(backoffDelayMs(spec, 4, QUEUES_CONFIG, noJitter)).toBe(1_800_000);
    expect(backoffDelayMs(spec, 7, QUEUES_CONFIG, noJitter)).toBe(43_200_000);
    expect(backoffDelayMs(spec, 99, QUEUES_CONFIG, noJitter)).toBe(43_200_000);
  });

  it('applies ±20% jitter, so a recovering endpoint is not hit by a thundering herd', () => {
    const spec = QUEUES['webhooks.deliver'].backoff;
    expect(backoffDelayMs(spec, 1, QUEUES_CONFIG, () => 0)).toBe(8_000);
    expect(backoffDelayMs(spec, 1, QUEUES_CONFIG, () => 1)).toBe(12_000);
  });

  it('treats a nonsensical attempt count as the first attempt rather than throwing', () => {
    const spec = QUEUES['grading.submit'].backoff;
    expect(backoffDelayMs(spec, 0, QUEUES_CONFIG, noJitter)).toBe(2_000);
    expect(backoffDelayMs(spec, -5, QUEUES_CONFIG, noJitter)).toBe(2_000);
    expect(backoffDelayMs(spec, Number.NaN, QUEUES_CONFIG, noJitter)).toBe(2_000);
  });

  it('never returns a negative delay', () => {
    const spec = QUEUES['grading.run'].backoff;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(backoffDelayMs(spec, attempt, QUEUES_CONFIG, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('backoffOptions', () => {
  it('expresses an exponential curve natively so BullMQ applies the jitter', () => {
    expect(backoffOptions('grading.submit', QUEUES_CONFIG)).toEqual({
      type: 'exponential',
      delay: 2_000,
      jitter: JITTER_RATIO,
    });
  });

  it('names the custom strategy for a queue whose curve is a table', () => {
    const options = backoffOptions('webhooks.deliver', QUEUES_CONFIG);
    expect(options.type).toBe(SCHEDULE_BACKOFF_TYPE);
  });
});
