/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing an assessment from a role (`H-179`, docs/03 §5).
 *
 * The plan is a query and the save is a mutation, which is the same split the API makes and
 * for the same reason: looking at the paper a role would produce costs nothing and can be
 * re-asked freely as the recruiter turns the dials, and saving it is the irreversible half.
 */

import {
  ASSESSMENTS_PATH,
  ASSESSMENT_AUTO_PATH,
  AssessmentListResponseSchema,
  AssessmentPlanSchema,
  AssessmentSchema,
  JOB_ROLE_ASSESSMENT_PLAN_PATH,
  type AssessmentListResponse,
  type AssessmentPlan,
  type AssessmentView,
  type CreateAssessment,
  type PlannedRule,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient } from './client.js';

export type { AssessmentPlan, AssessmentView, PlannedRule };

/** The dials a recruiter can turn. Both optional: a role alone composes a paper. */
export interface PlanOptions {
  readonly questionCount?: number | undefined;
  readonly durationSeconds?: number | undefined;
}

/**
 * What would be composed for this role — `GET /job-roles/{id}/assessment-plan`.
 *
 * The options are part of the cache key, so turning the question count from 6 to 8 and back
 * is instant and each value keeps its own loading state rather than the screen flickering
 * through a shared one.
 *
 * `staleTime` is short on purpose. `available` is a fact about the bank that changes the
 * moment a colleague publishes, and a recruiter who has just closed a gap should see it
 * closed rather than cached — the same reasoning the coverage query uses.
 */
export function assessmentPlanQuery(client: ApiClient, roleId: string, options: PlanOptions = {}) {
  return queryOptions<AssessmentPlan>({
    queryKey: [
      'job-roles',
      roleId,
      'assessment-plan',
      {
        questionCount: options.questionCount ?? null,
        durationSeconds: options.durationSeconds ?? null,
      },
    ],
    queryFn: ({ signal }) =>
      client.request(JOB_ROLE_ASSESSMENT_PLAN_PATH.replace('{id}', roleId), {
        schema: AssessmentPlanSchema,
        query: {
          question_count: options.questionCount,
          duration_seconds: options.durationSeconds,
        },
        signal,
      }),
    staleTime: 5_000,
  });
}

/** Every assessment composed so far — `GET /assessments`. */
export function assessmentsQuery(client: ApiClient) {
  return queryOptions<AssessmentListResponse>({
    queryKey: ['assessments'],
    queryFn: ({ signal }) =>
      client.request(ASSESSMENTS_PATH, { schema: AssessmentListResponseSchema, signal }),
    staleTime: 30_000,
  });
}

/** Saves the composition — `POST /assessments/auto`. */
export function createAssessmentRequest(
  client: ApiClient,
  body: CreateAssessment,
): Promise<AssessmentView> {
  return client.post(ASSESSMENT_AUTO_PATH, body, AssessmentSchema);
}

/** A rule the bank cannot currently supply. */
export function shortfallOf(rule: PlannedRule): number {
  return Math.max(rule.pick_count - rule.available, 0);
}

/**
 * Every rule of a plan, flattened.
 *
 * There is one section today and the shape allows many, so screens read through this rather
 * than through `sections[0]` — a screen written against the singular would break silently on
 * the day a second section exists, by showing half the paper.
 */
export function rulesOf(plan: AssessmentPlan): readonly PlannedRule[] {
  return plan.sections.flatMap((section) => section.rules);
}
