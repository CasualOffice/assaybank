/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The end-to-end queue test: a real Valkey, a real worker, a real dead letter.
 *
 * The unit tests cover the decisions — which attempt is the last one, how long a retry
 * waits, what the envelope contains. This one covers the wiring those decisions hang
 * from, which cannot be faked: that BullMQ actually retries to the budget the registry
 * declared, that the `failed` event fires on the last attempt with the counters the
 * decision function expects, and that the envelope reaches the dead-letter queue.
 *
 * **It skips cleanly when Valkey is not reachable.** P0's toolchain does not assume a
 * running Docker daemon, and a test that fails because an optional service is absent
 * teaches people to ignore red. Nothing is constructed at collection time either: a
 * queue handle opens a connection the moment it exists, and a skipped suite must not.
 *
 * Everything runs on Valkey database 15 so a developer's local queues are untouched, and
 * the queues used are obliterated at both ends of each suite.
 */

import { config } from '@assaybank/config';
import { toJobId } from '../../src/idempotency.js';
import type { QueuesConfig } from '@assaybank/config';
import { createLogger } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import type { Queue, Worker } from 'bullmq';
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DeadLetterEnvelope } from '../../src/dlq.js';
import { createDeadLetterQueue, createQueue, createWorker } from '../../src/queues.js';
import type { ConnectionScopedOptions } from '../../src/queues.js';

/** The test database. Never 0: that is where a developer's own stack lives. */
const TEST_DB = 15;

/** docs/13 §4.7's documented defaults, used when the environment has not been parsed. */
const FALLBACK_QUEUES: QueuesConfig = {
  runConcurrency: 4,
  submitConcurrency: 2,
  maxAttempts: 3,
  backoffMs: 2_000,
};

function readQueuesConfig(): QueuesConfig {
  try {
    return config.queues;
  } catch {
    return FALLBACK_QUEUES;
  }
}

function valkeyUrl(): string {
  try {
    return config.valkey.url;
  } catch {
    // The environment has not been parsed — the usual case in a bare test run. Fall back
    // to the local default rather than failing: the reachability probe decides.
    return 'redis://127.0.0.1:6379';
  }
}

/** True when something is listening. A 500 ms budget: this must not slow a suite down. */
async function reachable(url: string): Promise<boolean> {
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port === '' ? 6379 : Number(parsed.port);
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

const url = valkeyUrl();
const available = await reachable(url);

const scope: ConnectionScopedOptions = {
  connection: { url, maxRetriesPerRequest: null, db: TEST_DB },
  queues: readQueuesConfig(),
};

function silentLogger(): Logger {
  return createLogger({ service: 'worker-it', destination: { write: (): void => undefined } });
}

/** Resolves when `predicate` holds, or rejects once the budget is spent. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met within the budget');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

const suite = available ? describe : describe.skip;

if (!available) {
  // The only way a skip reason reaches the runner's output.
  console.warn(`[worker] Valkey unreachable at ${url}; queue integration tests skipped.`);
}

suite('a job that always fails', () => {
  const dead: DeadLetterEnvelope[] = [];
  let queue: Queue<{ marker: string }, void, string>;
  let deadLetterQueue: Queue<unknown, void, string>;
  let worker: Worker<{ marker: string }, void, string>;

  beforeAll(async () => {
    queue = createQueue<{ marker: string }, void>('maintenance.cron', scope);
    deadLetterQueue = createDeadLetterQueue('maintenance.cron', scope);
    await queue.obliterate({ force: true });
    await deadLetterQueue.obliterate({ force: true });

    worker = createWorker<{ marker: string }, void>(
      'maintenance.cron',
      () => Promise.reject(new Error('this job always fails')),
      {
        ...scope,
        logger: silentLogger(),
        deadLetter: {
          send(envelope): Promise<void> {
            dead.push(envelope);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        },
      },
    );
  });

  afterAll(async () => {
    await worker.close(true);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await deadLetterQueue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await deadLetterQueue.close();
  });

  it('reaches the dead-letter queue instead of disappearing', async () => {
    await queue.add('deadline-sweep', { marker: 'always-fails' }, { jobId: 'always-fails' });

    await until(() => dead.length > 0);

    const envelope = dead[0];
    expect(envelope?.queue).toBe('maintenance.cron');
    expect(envelope?.jobId).toBe('always-fails');
    expect(envelope?.reason).toBe('attempts_exhausted');
    // maintenance.cron allows one attempt: a missed tick is caught by the next one.
    expect(envelope?.attemptsMade).toBe(1);
    expect(envelope?.consequence).toContain('pages');
  });

  it('keeps the failed job, because the dead letter is the record of who was affected', async () => {
    await until(() => dead.length > 0);
    await expect(queue.getJobCountByTypes('failed')).resolves.toBeGreaterThan(0);
  });
});

suite('the no-op example job', () => {
  const completed: string[] = [];
  let queue: Queue<{ tick: string }, unknown, string>;
  let worker: Worker<{ tick: string }, { ok: boolean }, string>;

  beforeAll(async () => {
    queue = createQueue<{ tick: string }, unknown>('maintenance.cron', scope);
    await queue.obliterate({ force: true });

    worker = createWorker<{ tick: string }, { ok: boolean }>(
      'maintenance.cron',
      (job) => {
        completed.push(job.name);
        return Promise.resolve({ ok: true });
      },
      { ...scope, logger: silentLogger() },
    );
  });

  afterAll(async () => {
    await worker.close(true);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it('completes, and a second enqueue under the same business key is refused', async () => {
    // The business key carries a colon, which BullMQ forbids in a job id. Producers go
    // through toJobId() for exactly that reason, so the test uses it too rather than
    // hand-rolling a key the real code would never enqueue.
    const jobId = toJobId('example.noop:2026-09-16T10:00:00.000Z');
    await queue.add('example.noop', { tick: '2026-09-16T10:00:00.000Z' }, { jobId });
    await queue.add('example.noop', { tick: '2026-09-16T10:00:00.000Z' }, { jobId });

    await until(() => completed.length > 0);
    // BullMQ refuses a duplicate job id, which is the first of the two idempotency
    // layers: the business key stops a replayed enqueue before it becomes work.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    expect(completed).toEqual(['example.noop']);
  });
});
