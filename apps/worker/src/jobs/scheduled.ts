/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The six scheduled sweeps, and the cadence each runs on.
 *
 * The names and cadences come from `code-graph.json`'s `scheduled_jobs` array and are
 * not negotiable here: each one exists to protect a named invariant, recorded beside it
 * below so that the reason a sweep runs every sixty seconds is readable at the place
 * someone would go to change it.
 *
 * They all ride `maintenance.cron`, registered as BullMQ job schedulers at boot. That is
 * what makes a schedule survive a restart and what keeps two replicas from running the
 * same tick twice: the scheduler assigns one job per tick, and the job id is
 * `job_key:scheduled_for`.
 *
 * **In P0 every handler is a declared placeholder.** There is no domain yet — P0 builds
 * the skeleton and nothing else — so each one logs that it ran and what it did not do,
 * and returns. They are registered anyway, because a schedule that is only wired up in
 * the phase that implements it is a schedule whose registration is discovered to be
 * broken in that phase. The implementation of each lands in the milestone named below,
 * in the file `CODE-GRAPH.md` reserves for it.
 */

import type { Database } from '@assaybank/db';

import { runQuestionStats } from './question-stats.js';
import type { Logger } from '@assaybank/observability';

import { idempotent } from '../idempotency.js';

/** The six job keys, exactly as `code-graph.json` names their nodes. */
export const SCHEDULED_JOB_NAMES = [
  'deadline-sweep',
  'question-stats',
  'retention-erasure',
  'webhook-reaper',
  'proctor-media-deletion',
  'partition-roll',
] as const;

/** One of the six scheduled sweeps. */
export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];

/**
 * How often a sweep runs. `every` is a plain interval; `pattern` is a cron expression,
 * always with an explicit time zone — a nightly job on server-local time runs twice or
 * not at all on the days a daylight-saving boundary falls inside it.
 */
export type Cadence =
  | { readonly kind: 'every'; readonly ms: number }
  | { readonly kind: 'cron'; readonly pattern: string; readonly tz: string };

/** One sweep's declaration. */
export interface ScheduledJobSpec {
  readonly name: ScheduledJobName;
  /** The human name in `code-graph.json`, so a log line and a diagram agree. */
  readonly title: string;
  readonly cadence: Cadence;
  /** The milestone that implements it. Until then the handler is a placeholder. */
  readonly milestone: 'M0' | 'M1' | 'M3' | 'M4';
  /** The file `CODE-GRAPH.md` reserves for the implementation. */
  readonly implementedIn: string;
  /** What breaks if this sweep stops running. Copied from `code-graph.json`. */
  readonly invariant: string;
}

/** Every scheduled sweep, keyed by job name. */
export const SCHEDULED_JOBS: { readonly [K in ScheduledJobName]: ScheduledJobSpec } = {
  'deadline-sweep': {
    name: 'deadline-sweep',
    title: 'Deadline sweep',
    cadence: { kind: 'every', ms: 60_000 },
    milestone: 'M1',
    implementedIn: 'apps/worker/src/jobs/deadline-sweep.ts',
    invariant:
      'No attempt stays in_progress past deadline_at. The server sets expired, not the ' +
      'client, and whatever was autosaved is graded (ADR-006).',
  },
  'question-stats': {
    name: 'question-stats',
    title: 'Nightly question stats',
    cadence: { kind: 'cron', pattern: '30 2 * * *', tz: 'UTC' },
    milestone: 'M0',
    implementedIn: 'apps/worker/src/jobs/question-stats.ts',
    invariant:
      'Exposure, p-value, discrimination and mean time are recomputed from the record ' +
      'rather than incremented at request time, so they cannot drift and a re-grade ' +
      'cannot distort them.',
  },
  'retention-erasure': {
    name: 'retention-erasure',
    title: 'Retention erasure',
    cadence: { kind: 'cron', pattern: '30 3 * * *', tz: 'UTC' },
    milestone: 'M1',
    implementedIn: 'apps/worker/src/jobs/retention-erasure.ts',
    invariant:
      'Candidate PII disappears on the clock set by RETENTION_CANDIDATE_PII_MONTHS and ' +
      'candidates.erase_after, while de-identified scores and the audit log survive ' +
      'their own periods.',
  },
  'webhook-reaper': {
    name: 'webhook-reaper',
    title: 'Webhook retry reaper',
    cadence: { kind: 'every', ms: 300_000 },
    milestone: 'M1',
    implementedIn: 'apps/worker/src/jobs/webhook-reaper.ts',
    invariant:
      'At-least-once delivery inside a bounded 24-hour window. Every delivery reaches a ' +
      'terminal, visible state; none is retried forever and none vanishes.',
  },
  'proctor-media-deletion': {
    name: 'proctor-media-deletion',
    title: 'Proctor media deletion',
    cadence: { kind: 'cron', pattern: '0 * * * *', tz: 'UTC' },
    milestone: 'M4',
    implementedIn: 'apps/worker/src/jobs/proctor-media-deletion.ts',
    invariant:
      'Biometric media carries a hard ceiling of RETENTION_PROCTOR_MEDIA_DAYS that ' +
      'applies even to an attempt under review; deletion is unconditional and has no ' +
      'extension path (ADR-007).',
  },
  'partition-roll': {
    name: 'partition-roll',
    title: 'Monthly partition roll',
    cadence: { kind: 'cron', pattern: '0 1 * * *', tz: 'UTC' },
    milestone: 'M3',
    implementedIn: 'apps/worker/src/jobs/partition-roll.ts',
    invariant:
      'session_events and proctor_events always have a partition to land in, and ' +
      'partitions older than 90 days are archived to object storage before they are ' +
      'dropped.',
  },
};

/** Narrows a job name off a queue to one of the six sweeps. */
export function isScheduledJobName(value: unknown): value is ScheduledJobName {
  return typeof value === 'string' && (SCHEDULED_JOB_NAMES as readonly string[]).includes(value);
}

/**
 * The repeat options BullMQ needs for a cadence. Separated from registration so the
 * translation can be asserted in a test without a queue.
 */
export function repeatOptionsFor(
  cadence: Cadence,
): { readonly every: number } | { readonly pattern: string; readonly tz: string } {
  return cadence.kind === 'every'
    ? { every: cadence.ms }
    : { pattern: cadence.pattern, tz: cadence.tz };
}

/**
 * The business key for one tick: `job_key:scheduled_for`, exactly as `code-graph.json`
 * specifies, which guarantees one run per tick across every worker replica.
 *
 * `scheduledFor` comes from the job's own timestamp rather than from its payload. A
 * scheduler template is static — it cannot carry a per-tick value — and deriving the
 * instant from the job means two replicas processing the same tick compute the same key.
 */
export function scheduledJobKey(name: ScheduledJobName, scheduledFor: Date): string {
  return `${name}:${scheduledFor.toISOString()}`;
}

/** What a sweep reports back. In P0, always `ran: false`. */
export interface ScheduledJobOutcome {
  readonly job: ScheduledJobName;
  /** False while the sweep is a placeholder: nothing was read and nothing was written. */
  readonly ran: boolean;
  readonly scheduledFor: string;
  readonly milestone: string;
}

/** Everything {@link runScheduledJob} needs from its surroundings. */
export interface ScheduledJobDeps {
  readonly logger: Logger;
  /** The instant this tick was scheduled for, from the job's timestamp. */
  readonly scheduledFor: Date;
  /**
   * The database, for sweeps that have been implemented. Optional so a sweep can be exercised
   * without one — it then reports the placeholder rather than failing.
   */
  readonly db?: Database;
  /** The composition root's clock. Stamps what a sweep writes; never read inside the sweep. */
  readonly now?: () => Date;
}

/**
 * Runs one scheduled sweep, idempotently by `job_key:scheduled_for`.
 *
 * In P0 the body is the placeholder: it says which sweep did not run and which milestone
 * implements it, at `info` so that a stack which appears healthy is not also silent. When
 * a sweep is implemented, its body replaces the placeholder here and moves into the file
 * named in {@link ScheduledJobSpec.implementedIn}; the registration, the key, the
 * idempotency and the metrics do not change.
 */
export async function runScheduledJob(
  name: ScheduledJobName,
  deps: ScheduledJobDeps,
): Promise<ScheduledJobOutcome> {
  const spec = SCHEDULED_JOBS[name];
  const key = scheduledJobKey(name, deps.scheduledFor);

  return idempotent<ScheduledJobOutcome>(
    key,
    async () => {
      // Implemented sweeps. Each moves out of the placeholder as its milestone lands; the
      // registration, the key, the idempotency and the job metrics around it do not change.
      if (name === 'question-stats' && deps.db !== undefined) {
        const outcome = await runQuestionStats({
          db: deps.db,
          now: deps.now ?? ((): Date => deps.scheduledFor),
        });
        deps.logger.info(
          {
            event: 'sweep.completed',
            job: name,
            scheduled_for: deps.scheduledFor.toISOString(),
            organisations: outcome.organisations,
            versions_written: outcome.versionsWritten,
            versions_with_statistics: outcome.versionsWithStatistics,
          },
          `${spec.title} completed`,
        );
        return {
          job: name,
          ran: true,
          scheduledFor: deps.scheduledFor.toISOString(),
          milestone: spec.milestone,
        };
      }

      deps.logger.info(
        {
          event: 'sweep.placeholder',
          job: name,
          title: spec.title,
          milestone: spec.milestone,
          implemented_in: spec.implementedIn,
          scheduled_for: deps.scheduledFor.toISOString(),
        },
        `${spec.title} is scheduled but not yet implemented; it lands in ${spec.milestone}`,
      );

      return {
        job: name,
        ran: false,
        scheduledFor: deps.scheduledFor.toISOString(),
        milestone: spec.milestone,
      };
    },
    { queue: 'maintenance.cron' },
  );
}
