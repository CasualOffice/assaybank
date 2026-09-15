/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger } from '@assaybank/observability';
import type { Logger } from '@assaybank/observability';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MemoryIdempotencyStore, resetIdempotency, setIdempotencyStore } from '../idempotency.js';
import {
  isScheduledJobName,
  repeatOptionsFor,
  runScheduledJob,
  SCHEDULED_JOB_NAMES,
  SCHEDULED_JOBS,
  scheduledJobKey,
} from './scheduled.js';

function silentLogger(): Logger {
  return createLogger({ service: 'worker-test', destination: { write: (): void => undefined } });
}

const TICK = new Date('2026-09-16T02:30:00.000Z');

const CodeGraphSchema = z.object({
  scheduled_jobs: z.array(z.object({ node: z.string(), cadence: z.string() })),
});

function codeGraphJobs(): ReadonlyArray<{ node: string; cadence: string }> {
  const raw = readFileSync(new URL('../../../../code-graph.json', import.meta.url), 'utf8');
  return CodeGraphSchema.parse(JSON.parse(raw)).scheduled_jobs;
}

beforeEach(() => {
  resetIdempotency();
});

describe('the six scheduled sweeps', () => {
  it('are exactly the jobs code-graph.json declares', () => {
    // The graph names them `job-<name>`; the queue uses the bare name as the job name.
    const expected = codeGraphJobs()
      .map((job) => job.node.replace(/^job-/u, ''))
      .sort();
    expect([...SCHEDULED_JOB_NAMES].sort()).toEqual(expected);
  });

  it('records the invariant each one protects, so nobody silently disables it', () => {
    for (const name of SCHEDULED_JOB_NAMES) {
      expect(SCHEDULED_JOBS[name].invariant.length).toBeGreaterThan(40);
      expect(SCHEDULED_JOBS[name].name).toBe(name);
    }
  });

  it('points at the file CODE-GRAPH.md reserves for each implementation', () => {
    for (const name of SCHEDULED_JOB_NAMES) {
      expect(SCHEDULED_JOBS[name].implementedIn).toBe(`apps/worker/src/jobs/${name}.ts`);
    }
  });

  it('runs the deadline sweep every sixty seconds, because ADR-006 owns the clock', () => {
    expect(SCHEDULED_JOBS['deadline-sweep'].cadence).toEqual({ kind: 'every', ms: 60_000 });
  });

  it('pins every nightly sweep to UTC rather than to server-local time', () => {
    // A nightly job on local time runs twice, or not at all, on a daylight-saving day.
    for (const name of SCHEDULED_JOB_NAMES) {
      const cadence = SCHEDULED_JOBS[name].cadence;
      if (cadence.kind === 'cron') expect(cadence.tz).toBe('UTC');
    }
  });

  it('narrows a job name off the queue', () => {
    expect(isScheduledJobName('deadline-sweep')).toBe(true);
    expect(isScheduledJobName('example.noop')).toBe(false);
    expect(isScheduledJobName(7)).toBe(false);
  });
});

describe('repeatOptionsFor', () => {
  it('translates an interval', () => {
    expect(repeatOptionsFor({ kind: 'every', ms: 300_000 })).toEqual({ every: 300_000 });
  });

  it('translates a cron pattern with its time zone', () => {
    expect(repeatOptionsFor({ kind: 'cron', pattern: '30 2 * * *', tz: 'UTC' })).toEqual({
      pattern: '30 2 * * *',
      tz: 'UTC',
    });
  });
});

describe('scheduledJobKey', () => {
  it('is job_key:scheduled_for, which guarantees one run per tick across replicas', () => {
    expect(scheduledJobKey('question-stats', TICK)).toBe('question-stats:2026-09-16T02:30:00.000Z');
  });

  it('gives two replicas the same key for the same tick', () => {
    expect(scheduledJobKey('deadline-sweep', new Date(TICK))).toBe(
      scheduledJobKey('deadline-sweep', new Date(TICK.getTime())),
    );
  });
});

describe('runScheduledJob', () => {
  it('reports honestly that the sweep is not implemented yet', async () => {
    setIdempotencyStore(new MemoryIdempotencyStore());
    const outcome = await runScheduledJob('deadline-sweep', {
      logger: silentLogger(),
      scheduledFor: TICK,
    });

    expect(outcome).toEqual({
      job: 'deadline-sweep',
      ran: false,
      scheduledFor: '2026-09-16T02:30:00.000Z',
      milestone: 'M1',
    });
  });

  it('runs a tick once, even if two replicas pick it up', async () => {
    const store = new MemoryIdempotencyStore();
    setIdempotencyStore(store);

    await runScheduledJob('webhook-reaper', { logger: silentLogger(), scheduledFor: TICK });
    await runScheduledJob('webhook-reaper', { logger: silentLogger(), scheduledFor: TICK });

    expect(store.size).toBe(1);
  });

  it('treats the next tick as separate work', async () => {
    const store = new MemoryIdempotencyStore();
    setIdempotencyStore(store);

    await runScheduledJob('webhook-reaper', { logger: silentLogger(), scheduledFor: TICK });
    await runScheduledJob('webhook-reaper', {
      logger: silentLogger(),
      scheduledFor: new Date(TICK.getTime() + 300_000),
    });

    expect(store.size).toBe(2);
  });
});
