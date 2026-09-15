/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The label guard, which is the part of the metrics worth testing.
 *
 * Unbounded cardinality is the failure mode that takes out the tool you diagnose outages
 * with, and it takes it out at peak, because peak is when the unbounded thing has the
 * most distinct values. docs/12 §6 forbids it by construction; these tests assert that
 * the construction actually forbids it, for the identifiers a worker is most tempted to
 * label with — a submission id in a duration histogram, an attempt id in a failure
 * counter.
 */

import { gauge, MetricCardinalityError, metrics as registry } from '@assaybank/observability';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifyFailure,
  FAILURE_REASONS,
  KNOWN_JOB_NAMES,
  dlqDepth,
  jobDuration,
  observeTimeInQueue,
  queueDepth,
  recordDeadLetterDepth,
  recordOldestJobAge,
  recordQueueDepth,
  timeInQueue,
} from './metrics.js';
import { QUEUE_NAMES } from './queue-names.js';
import { SCHEDULED_JOB_NAMES } from './jobs/scheduled.js';

async function exposition(): Promise<string> {
  return registry.metrics();
}

beforeEach(() => {
  queueDepth.reset();
  dlqDepth.reset();
  jobDuration.reset();
  timeInQueue.reset();
});

describe('metric names', () => {
  it('uses the names docs/12 §4.1 fixes, which alerts and dashboards reference', () => {
    expect(queueDepth.name).toBe('bullmq_queue_depth');
    expect(dlqDepth.name).toBe('bullmq_dlq_depth');
    expect(jobDuration.name).toBe('bullmq_job_duration_seconds');
    expect(timeInQueue.name).toBe('bullmq_time_in_queue_seconds');
  });

  it('measures durations in seconds, never milliseconds', () => {
    for (const name of [jobDuration.name, timeInQueue.name]) {
      expect(name.endsWith('_seconds')).toBe(true);
      expect(name.endsWith('_ms')).toBe(false);
    }
  });
});

describe('the label guard', () => {
  it('refuses an identifier label at construction, so it is a failed boot not an outage', () => {
    for (const forbidden of ['attempt_id', 'candidate_id', 'question_id', 'submission_id']) {
      expect(() =>
        gauge({
          name: `worker_guard_probe_${forbidden}`,
          help: 'a metric that must never be constructible',
          labelNames: [forbidden],
        }),
      ).toThrow(MetricCardinalityError);
    }
  });

  it('refuses org_id, which is unbounded and leaks the tenant list to anyone scraping', () => {
    expect(() =>
      gauge({ name: 'worker_guard_probe_org', help: 'never', labelNames: ['org_id'] }),
    ).toThrow(MetricCardinalityError);
  });

  it('folds a queue label outside the six canonical names to "other"', async () => {
    queueDepth.set({ queue: 'grading.submit', priority: 'batch', state: 'waiting' }, 7);
    queueDepth.set({ queue: 'not-a-real-queue', priority: 'batch', state: 'waiting' }, 3);

    const body = await exposition();
    expect(body).toMatch(/bullmq_queue_depth\{[^}]*queue="grading\.submit"[^}]*\} 7/u);
    expect(body).toContain('queue="other"');
    expect(body).not.toContain('not-a-real-queue');
  });

  it('folds a job name outside the declared set, so an ad-hoc name cannot grow the series', async () => {
    jobDuration.observe({ queue: 'maintenance.cron', job_name: 'deadline-sweep' }, 0.5);
    jobDuration.observe({ queue: 'maintenance.cron', job_name: 'grade-attempt-a1b2c3' }, 0.5);

    const body = await exposition();
    expect(body).toContain('job_name="deadline-sweep"');
    expect(body).toContain('job_name="other"');
    expect(body).not.toContain('a1b2c3');
  });
});

describe('the declared label sets', () => {
  it('lists every scheduled sweep as a known job name', () => {
    // Adding a sweep without adding it here would fold its panel into "other".
    for (const name of SCHEDULED_JOB_NAMES) {
      expect(KNOWN_JOB_NAMES).toContain(name);
    }
  });

  it('keeps the failure reasons to the closed set docs/12 §4.1 names', () => {
    expect([...FAILURE_REASONS]).toEqual([
      'exec_unavailable',
      'timeout',
      'db_error',
      'validation',
      'unknown',
    ]);
  });
});

describe('recording helpers', () => {
  it('records waiting and delayed as two series of one gauge', async () => {
    recordQueueDepth('grading.submit', { waiting: 12, delayed: 4 });
    const body = await exposition();
    expect(body).toMatch(/bullmq_queue_depth\{[^}]*state="waiting"[^}]*\} 12/u);
    expect(body).toMatch(/bullmq_queue_depth\{[^}]*state="delayed"[^}]*\} 4/u);
  });

  it('labels the priority from the queue, so a caller cannot mislabel it', async () => {
    recordQueueDepth('grading.run', { waiting: 1, delayed: 0 });
    const body = await exposition();
    expect(body).toMatch(/queue="grading\.run"[^}]*priority="interactive"/u);
  });

  it('records a dead-letter depth per queue', async () => {
    recordDeadLetterDepth('webhooks.deliver', 2);
    expect(await exposition()).toContain('bullmq_dlq_depth{queue="webhooks.deliver"} 2');
  });

  it('records the head-of-queue age, which is what a flat depth hides', async () => {
    recordOldestJobAge('grading.submit', 412);
    expect(await exposition()).toContain(
      'bullmq_oldest_job_age_seconds{queue="grading.submit"} 412',
    );
  });

  it('observes a queue wait for every canonical queue without throwing', () => {
    for (const queue of QUEUE_NAMES) {
      expect(() => {
        observeTimeInQueue(queue, 1.5);
      }).not.toThrow();
    }
  });
});

describe('classifyFailure', () => {
  it('buckets an unreachable sandbox', () => {
    expect(classifyFailure(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(
      'exec_unavailable',
    );
    expect(classifyFailure(new Error('piston returned 503'))).toBe('exec_unavailable');
  });

  it('buckets a timeout', () => {
    expect(classifyFailure(new Error('request timeout after 30s'))).toBe('timeout');
    expect(classifyFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
  });

  it('buckets a validation failure', () => {
    expect(classifyFailure(Object.assign(new Error('bad'), { name: 'ZodError' }))).toBe(
      'validation',
    );
  });

  it('buckets a database failure', () => {
    expect(classifyFailure(new Error('deadlock detected'))).toBe('db_error');
    expect(classifyFailure(new Error('violates check constraint "x"'))).toBe('db_error');
  });

  it('buckets anything else as unknown, and never as a new label value', () => {
    expect(classifyFailure(new Error('something odd'))).toBe('unknown');
    expect(classifyFailure('a thrown string')).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
    expect(FAILURE_REASONS).toContain(classifyFailure(new Error('something odd')));
  });
});
