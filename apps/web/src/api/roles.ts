/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server state for job roles and what the bank can measure about them.
 *
 * The same `queryOptions()` shape as the question bank, for the same reason: one object a
 * component can hand to `useQuery`, a route can hand to `ensureQueryData`, and a test can
 * execute directly.
 */

import {
  JOB_ROLES_PATH,
  JOB_ROLE_COVERAGE_PATH,
  JobRoleCoverageSchema,
  JobRoleListResponseSchema,
  type JobRoleCoverage,
  type JobRoleListResponse,
  type JobRoleView,
  type SkillCoverage,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient } from './client.js';

export type { JobRoleCoverage, JobRoleView, SkillCoverage };

/** Every role the organisation hires for. */
export function rolesQuery(client: ApiClient) {
  return queryOptions<JobRoleListResponse>({
    queryKey: ['job-roles'],
    queryFn: ({ signal }) =>
      client.request(JOB_ROLES_PATH, { schema: JobRoleListResponseSchema, signal }),
    // Roles change when somebody defines one, which is rare. A minute is long enough that
    // moving between roles is instant and short enough that a colleague's new role appears.
    staleTime: 60_000,
  });
}

/** What the bank can and cannot measure for one role — `GET /job-roles/{id}/coverage`. */
export function roleCoverageQuery(client: ApiClient, id: string) {
  return queryOptions<JobRoleCoverage>({
    queryKey: ['job-roles', id, 'coverage'],
    queryFn: ({ signal }) =>
      client.request(JOB_ROLE_COVERAGE_PATH.replace('{id}', id), {
        schema: JobRoleCoverageSchema,
        signal,
      }),
    // Deliberately short. This number changes the moment somebody publishes a question, and
    // a recruiter who has just closed a gap should see it closed rather than cached.
    staleTime: 5_000,
  });
}

/**
 * Whether a role can be assessed from the bank as it stands.
 *
 * `blocked` is a required skill with nothing published in its difficulty band — the
 * assessment cannot be composed. `thin` is one with something, but not enough to draw a
 * different set per candidate without repetition, which is the fairness problem in
 * docs/18 §3.2 rather than a feasibility one. The threshold is deliberately a constant here
 * and not a setting: it is a judgement, and a settable judgement is one nobody owns.
 */
export const THIN_BAND_THRESHOLD = 5;

/**
 * The number of in-band questions a coverage bar treats as a full one.
 *
 * Not a rule and not a target anybody is asked to hit — a scale, so that "14" and "3" are
 * distinguishable at a glance rather than being two numbers of similar width. Ten is roughly
 * where drawing a different set per candidate stops being the constraint, which makes it the
 * honest place for the bar to stop growing; beyond it, more questions help the bank and no
 * longer change this particular judgement.
 *
 * A bar is capped here and the count beside it is not, so a skill with forty is shown as full
 * and still says forty. A bar that kept growing would make the scale meaningless for
 * everything else on the screen.
 */
export const COMFORTABLE_BAND_TARGET = 10;

/** Where one skill sits against that scale, as a fraction between 0 and 1. */
export function bandFill(skill: SkillCoverage): number {
  return Math.min(skill.in_band / COMFORTABLE_BAND_TARGET, 1);
}

/** The tone a skill's coverage reads as, by the same thresholds the verdict uses. */
export function bandTone(skill: SkillCoverage): 'danger' | 'warning' | 'success' {
  if (skill.in_band === 0) return 'danger';
  return skill.in_band < THIN_BAND_THRESHOLD ? 'warning' : 'success';
}

export interface CoverageVerdict {
  readonly blocked: readonly SkillCoverage[];
  readonly thin: readonly SkillCoverage[];
  readonly ready: boolean;
}

export function verdictFor(coverage: JobRoleCoverage): CoverageVerdict {
  const required = coverage.skills.filter((skill) => skill.is_required);
  const blocked = required.filter((skill) => skill.in_band === 0);
  const thin = required.filter((skill) => skill.in_band > 0 && skill.in_band < THIN_BAND_THRESHOLD);
  return { blocked, thin, ready: blocked.length === 0 };
}

/** "Difficulty 3 to 4", or "any difficulty" when the role does not narrow it. */
export function bandLabel(skill: SkillCoverage): string {
  const { min_difficulty: min, max_difficulty: max } = skill;
  if (min === null && max === null) return 'any difficulty';
  if (min !== null && max !== null) {
    return min === max ? `difficulty ${String(min)}` : `difficulty ${String(min)}–${String(max)}`;
  }
  return min === null ? `difficulty up to ${String(max)}` : `difficulty ${String(min)} and above`;
}
