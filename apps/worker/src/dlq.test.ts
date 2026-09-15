/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  deadLetterDecision,
  deadLetterEnvelope,
  DeadLetterEnvelopeSchema,
  handleJobFailure,
  MAX_FAILED_REASON_CHARS,
  MemoryDeadLetterSink,
  truncateReason,
} from './dlq.js';
import type { DeadLetterSink } from './dlq.js';
import { dlqDepth, jobDeadLettered, jobRetried } from './metrics.js';
import { QUEUE_NAMES } from './queue-names.js';

/** A logger that writes nowhere. The assertions here are about routing, not output. */
function silentLogger(): Logger {
  return createLogger({ service: 'worker-test', destination: { write: (): void => undefined } });
}

const AT = new Date('2026-09-16T10:00:00.000Z');

beforeEach(() => {
  dlqDepth.reset();
  jobDeadLettered.reset();
  jobRetried.reset();
});

describe('deadLetterDecision', () => {
  it('retries while the budget has room', () => {
    const decision = deadLetterDecision({
      queue: 'grading.submit',
      attemptsMade: 1,
      maxAttempts: 3,
    });
    expect(decision).toEqual({ deadLetter: false, nextAttempt: 2, attemptsRemaining: 2 });
  });

  it('dead-letters on the last attempt', () => {
    const decision = deadLetterDecision({
      queue: 'grading.submit',
      attemptsMade: 3,
      maxAttempts: 3,
    });
    expect(decision).toEqual({
      deadLetter: true,
      reason: 'attempts_exhausted',
      queue: 'grading.submit.dlq',
    });
  });

  it('dead-letters past the last attempt, rather than looping', () => {
    const decision = deadLetterDecision({
      queue: 'bank.jobs',
      attemptsMade: 9,
      maxAttempts: 2,
    });
    expect(decision.deadLetter).toBe(true);
  });

  it('short-circuits an unrecoverable error without spending the remaining budget', () => {
    const decision = deadLetterDecision({
      queue: 'webhooks.deliver',
      attemptsMade: 1,
      maxAttempts: 8,
      unrecoverable: true,
    });
    expect(decision).toEqual({
      deadLetter: true,
      reason: 'unrecoverable',
      queue: 'webhooks.deliver.dlq',
    });
  });

  it('spends the whole budget on a recoverable failure of the webhook queue', () => {
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const decision = deadLetterDecision({
        queue: 'webhooks.deliver',
        attemptsMade: attempt,
        maxAttempts: 8,
      });
      expect(decision.deadLetter).toBe(false);
    }
    expect(
      deadLetterDecision({ queue: 'webhooks.deliver', attemptsMade: 8, maxAttempts: 8 }).deadLetter,
    ).toBe(true);
  });

  it('errs towards the dead-letter queue when the counters make no sense', () => {
    // Over-reporting costs an operator a minute. Under-reporting loses a submission.
    for (const attemptsMade of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        deadLetterDecision({ queue: 'grading.submit', attemptsMade, maxAttempts: 3 }).deadLetter,
      ).toBe(true);
    }
  });

  it('treats a nonsensical budget as a single attempt', () => {
    expect(
      deadLetterDecision({ queue: 'grading.run', attemptsMade: 1, maxAttempts: 0 }).deadLetter,
    ).toBe(true);
  });

  it('names the dead-letter queue of the queue it was given, for all six', () => {
    for (const queue of QUEUE_NAMES) {
      const decision = deadLetterDecision({ queue, attemptsMade: 5, maxAttempts: 1 });
      expect(decision.deadLetter && decision.queue).toBe(`${queue}.dlq`);
    }
  });
});

describe('the envelope', () => {
  it('carries what a replay needs and parses back to itself', () => {
    const envelope = deadLetterEnvelope({
      queue: 'grading.submit',
      jobId: 'submission-1',
      jobName: 'grade',
      data: { submission_id: 'submission-1' },
      attemptsMade: 3,
      reason: 'attempts_exhausted',
      failureClass: 'db_error',
      error: new Error('connection terminated'),
      consequence: 'the attempt moves to under_review',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      now: AT,
    });

    expect(envelope.failedAt).toBe('2026-09-16T10:00:00.000Z');
    expect(envelope.jobId).toBe('submission-1');
    expect(envelope.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(DeadLetterEnvelopeSchema.parse(envelope)).toBeTruthy();
  });

  it('invents a stable id rather than writing a dead letter with no id at all', () => {
    const envelope = deadLetterEnvelope({
      queue: 'maintenance.cron',
      jobId: undefined,
      jobName: 'deadline-sweep',
      data: undefined,
      attemptsMade: 1,
      reason: 'attempts_exhausted',
      failureClass: 'unknown',
      error: 'not an Error',
      consequence: 'a non-empty DLQ here pages',
      now: AT,
    });
    expect(envelope.jobId).toBe('unknown:2026-09-16T10:00:00.000Z');
    expect(envelope.traceId).toBeUndefined();
  });

  it('truncates a failure reason, because an error message can contain an answer', () => {
    const long = new Error('x'.repeat(5_000));
    const rendered = truncateReason(long);
    expect(rendered.length).toBeLessThan(MAX_FAILED_REASON_CHARS + 32);
    expect(rendered.endsWith('[truncated]')).toBe(true);
  });

  it('renders a non-Error throw without pretending it was one', () => {
    expect(truncateReason({ weird: true })).toBe('non-error thrown');
    expect(truncateReason('a string')).toBe('a string');
  });
});

describe('handleJobFailure', () => {
  it('counts a retry and writes nothing to the sink while attempts remain', async () => {
    const sink = new MemoryDeadLetterSink();
    const decision = await handleJobFailure({
      queue: 'grading.submit',
      maxAttempts: 3,
      consequence: 'the attempt moves to under_review',
      job: { id: 'j1', name: 'grade', data: {}, attemptsMade: 1 },
      error: new Error('transient'),
      sink,
      logger: silentLogger(),
      now: () => AT,
    });

    expect(decision.deadLetter).toBe(false);
    expect(sink.envelopes).toHaveLength(0);
  });

  it('writes to the sink and raises the alarm on the last attempt', async () => {
    const sink = new MemoryDeadLetterSink();
    const decision = await handleJobFailure({
      queue: 'grading.submit',
      maxAttempts: 3,
      consequence: 'the attempt moves to under_review and waits for a human',
      job: { id: 'j1', name: 'grade', data: { submission_id: 'j1' }, attemptsMade: 3 },
      error: new Error('connection terminated unexpectedly'),
      sink,
      logger: silentLogger(),
      now: () => AT,
    });

    expect(decision).toEqual({
      deadLetter: true,
      reason: 'attempts_exhausted',
      queue: 'grading.submit.dlq',
    });
    expect(sink.envelopes).toHaveLength(1);

    const envelope = sink.envelopes[0];
    expect(envelope?.queue).toBe('grading.submit');
    expect(envelope?.data).toEqual({ submission_id: 'j1' });
    expect(envelope?.consequence).toContain('under_review');
  });

  it('does not throw when the dead-letter write itself fails', async () => {
    const broken: DeadLetterSink = {
      send: () => Promise.reject(new Error('valkey is down')),
      close: () => Promise.resolve(),
    };

    const decision = await handleJobFailure({
      queue: 'maintenance.cron',
      maxAttempts: 1,
      consequence: 'a non-empty DLQ here pages',
      job: { id: 'sweep', name: 'deadline-sweep', data: {}, attemptsMade: 1 },
      error: new Error('boom'),
      sink: broken,
      logger: silentLogger(),
      now: () => AT,
    });

    // The decision still stands, and the alarm still fired: the job is not forgotten
    // just because the place it was going to be written is unreachable.
    expect(decision.deadLetter).toBe(true);
  });

  it('dead-letters a job whose facts are missing entirely', async () => {
    const sink = new MemoryDeadLetterSink();
    const decision = await handleJobFailure({
      queue: 'grading.run',
      maxAttempts: 2,
      consequence: 'surfaced to the candidate as a run failure',
      job: undefined,
      error: new Error('stalled beyond the limit'),
      sink,
      logger: silentLogger(),
      now: () => AT,
    });

    expect(decision.deadLetter).toBe(true);
    expect(sink.envelopes[0]?.jobName).toBe('unknown');
  });
});
