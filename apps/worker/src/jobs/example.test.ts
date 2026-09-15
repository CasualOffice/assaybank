/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore, resetIdempotency } from '../idempotency.js';
import {
  EXAMPLE_JOB_NAME,
  ExampleJobPayloadSchema,
  exampleJobKey,
  exampleJobPayload,
  runExampleJob,
} from './example.js';

function silentLogger(): Logger {
  return createLogger({ service: 'worker-test', destination: { write: (): void => undefined } });
}

const FIRST = new Date('2026-09-16T10:00:00.000Z');
const LATER = new Date('2026-09-16T10:05:00.000Z');

beforeEach(() => {
  resetIdempotency();
});

describe('the example job payload', () => {
  it('is an RFC 3339 instant with an offset', () => {
    expect(ExampleJobPayloadSchema.parse({ tick: FIRST.toISOString() })).toEqual({
      tick: '2026-09-16T10:00:00.000Z',
    });
  });

  it('rejects anything else, because job.data came out of Valkey unverified', () => {
    expect(() => ExampleJobPayloadSchema.parse({ tick: 'yesterday' })).toThrow();
    expect(() => ExampleJobPayloadSchema.parse({})).toThrow();
    expect(() => ExampleJobPayloadSchema.parse(null)).toThrow();
  });

  it('ignores the trace carrier the producer added, rather than rejecting it', () => {
    const parsed = ExampleJobPayloadSchema.parse({
      tick: FIRST.toISOString(),
      _otel: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    expect(parsed).toEqual({ tick: '2026-09-16T10:00:00.000Z' });
  });

  it('builds its key from the job name and the tick', () => {
    expect(exampleJobKey(exampleJobPayload(FIRST))).toBe(
      `${EXAMPLE_JOB_NAME}:2026-09-16T10:00:00.000Z`,
    );
  });
});

describe('runExampleJob', () => {
  it('runs, and reports the instant it completed', async () => {
    const store = new MemoryIdempotencyStore();
    const result = await runExampleJob(exampleJobPayload(FIRST), {
      logger: silentLogger(),
      now: () => FIRST,
      store,
    });

    expect(result).toEqual({
      job: EXAMPLE_JOB_NAME,
      tick: '2026-09-16T10:00:00.000Z',
      completedAt: '2026-09-16T10:00:00.000Z',
    });
  });

  it('returns the first run’s result on a redelivery, not a second run’s', async () => {
    // This is the whole contract: at-least-once delivery makes redelivery normal, and a
    // replay must be indistinguishable from the original, including in its timestamps.
    const store = new MemoryIdempotencyStore();
    const payload = exampleJobPayload(FIRST);

    const first = await runExampleJob(payload, {
      logger: silentLogger(),
      now: () => FIRST,
      store,
    });
    const replayed = await runExampleJob(payload, {
      logger: silentLogger(),
      now: () => LATER,
      store,
    });

    expect(replayed).toEqual(first);
    expect(replayed.completedAt).toBe('2026-09-16T10:00:00.000Z');
  });

  it('treats a different tick as different work', async () => {
    const store = new MemoryIdempotencyStore();
    const a = await runExampleJob(exampleJobPayload(FIRST), {
      logger: silentLogger(),
      now: () => FIRST,
      store,
    });
    const b = await runExampleJob(exampleJobPayload(LATER), {
      logger: silentLogger(),
      now: () => LATER,
      store,
    });

    expect(a.tick).not.toBe(b.tick);
  });

  it('throws on a malformed payload, which the attempt budget then spends and dead-letters', async () => {
    await expect(
      runExampleJob({ tick: 42 }, { logger: silentLogger(), now: () => FIRST }),
    ).rejects.toThrow();
  });
});
