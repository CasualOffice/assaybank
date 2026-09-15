/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger, metrics as registry } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dlqDepth, oldestJobAge, queueDepth } from './metrics.js';
import { queueProbe, sampleOnce, startDepthSampler } from './sampler.js';
import type { CountableQueue, DepthProbe } from './sampler.js';

function silentLogger(): Logger {
  return createLogger({ service: 'worker-test', destination: { write: (): void => undefined } });
}

const NOW = new Date('2026-09-16T10:00:00.000Z');

function probe(overrides: Partial<DepthProbe> = {}): DepthProbe {
  return {
    queue: 'grading.submit',
    counts: () => Promise.resolve({ waiting: 0, delayed: 0 }),
    oldestJobTimestamp: () => Promise.resolve(undefined),
    deadLetterDepth: () => Promise.resolve(0),
    ...overrides,
  };
}

beforeEach(() => {
  queueDepth.reset();
  dlqDepth.reset();
  oldestJobAge.reset();
});

describe('sampleOnce', () => {
  it('records depth, dead-letter depth and the age of the head of the queue', async () => {
    await sampleOnce(
      [
        probe({
          counts: () => Promise.resolve({ waiting: 11, delayed: 2 }),
          oldestJobTimestamp: () => Promise.resolve(NOW.getTime() - 420_000),
          deadLetterDepth: () => Promise.resolve(3),
        }),
      ],
      () => NOW,
      silentLogger(),
    );

    const body = await registry.metrics();
    expect(body).toMatch(/bullmq_queue_depth\{[^}]*state="waiting"[^}]*\} 11/u);
    expect(body).toMatch(/bullmq_queue_depth\{[^}]*state="delayed"[^}]*\} 2/u);
    expect(body).toContain('bullmq_dlq_depth{queue="grading.submit"} 3');
    expect(body).toContain('bullmq_oldest_job_age_seconds{queue="grading.submit"} 420');
  });

  it('reports an age of zero for an empty queue rather than leaving a stale reading', async () => {
    await sampleOnce([probe()], () => NOW, silentLogger());
    expect(await registry.metrics()).toContain(
      'bullmq_oldest_job_age_seconds{queue="grading.submit"} 0',
    );
  });

  it('never reports a negative age when the clocks disagree', async () => {
    await sampleOnce(
      [probe({ oldestJobTimestamp: () => Promise.resolve(NOW.getTime() + 60_000) })],
      () => NOW,
      silentLogger(),
    );
    expect(await registry.metrics()).toContain(
      'bullmq_oldest_job_age_seconds{queue="grading.submit"} 0',
    );
  });

  it('survives a probe that throws, because the gap in the series is itself the signal', async () => {
    const good = probe({
      queue: 'bank.jobs',
      counts: () => Promise.resolve({ waiting: 5, delayed: 0 }),
    });
    const bad = probe({ counts: () => Promise.reject(new Error('valkey is down')) });

    await expect(sampleOnce([bad, good], () => NOW, silentLogger())).resolves.toBeUndefined();
    expect(await registry.metrics()).toMatch(/queue="bank\.jobs"[^}]*state="waiting"[^}]*\} 5/u);
  });

  it('samples every probe in one pass', async () => {
    const a = vi.fn(() => Promise.resolve({ waiting: 1, delayed: 0 }));
    const b = vi.fn(() => Promise.resolve({ waiting: 2, delayed: 0 }));

    await sampleOnce(
      [probe({ counts: a }), probe({ queue: 'grading.run', counts: b })],
      () => NOW,
      silentLogger(),
    );

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('queueProbe', () => {
  it('reads the head of the waiting list only, never the backlog', async () => {
    const getWaiting = vi.fn(() => Promise.resolve([{ timestamp: 1_700_000_000_000 }]));
    const queue: CountableQueue = {
      getWaiting,
      getWaitingCount: () => Promise.resolve(9),
      getDelayedCount: () => Promise.resolve(1),
    };
    const dlq = { getWaitingCount: (): Promise<number> => Promise.resolve(2) };

    const built = queueProbe('grading.submit', queue, dlq);

    await expect(built.counts()).resolves.toEqual({ waiting: 9, delayed: 1 });
    await expect(built.oldestJobTimestamp()).resolves.toBe(1_700_000_000_000);
    await expect(built.deadLetterDepth()).resolves.toBe(2);
    expect(getWaiting).toHaveBeenCalledWith(0, 0);
  });

  it('reports no head when the queue is empty', async () => {
    const queue: CountableQueue = {
      getWaiting: () => Promise.resolve([]),
      getWaitingCount: () => Promise.resolve(0),
      getDelayedCount: () => Promise.resolve(0),
    };
    const built = queueProbe('grading.run', queue, {
      getWaitingCount: () => Promise.resolve(0),
    });
    await expect(built.oldestJobTimestamp()).resolves.toBeUndefined();
  });
});

describe('startDepthSampler', () => {
  it('samples on demand without needing a timer to fire', async () => {
    const counts = vi.fn(() => Promise.resolve({ waiting: 4, delayed: 0 }));
    const sampler = startDepthSampler({
      logger: silentLogger(),
      probes: [probe({ counts })],
      now: () => NOW,
      intervalMs: 3_600_000,
    });

    await sampler.sample();
    await sampler.stop();

    expect(counts).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly and does not keep the process alive', async () => {
    const sampler = startDepthSampler({
      logger: silentLogger(),
      probes: [probe()],
      now: () => NOW,
    });
    await expect(sampler.stop()).resolves.toBeUndefined();
  });
});
