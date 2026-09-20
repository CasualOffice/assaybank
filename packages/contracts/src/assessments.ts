/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing an assessment from a role (`H-179`, docs/18 §2.2).
 *
 * ## Two endpoints, because a plan is a read and an assessment is a write
 *
 * `GET /job-roles/{id}/assessment-plan` answers *what would be composed, and can the bank
 * supply it*. `POST /assessments/auto` composes the same thing and writes it. The plan is a read
 * so the console can show a recruiter the paper before they commit to it, and so that
 * looking is free — a preview that created a draft would leave a trail of abandoned drafts
 * behind every recruiter who was only curious.
 *
 * Both derive from one pure function, `composeFromRole` in `packages/core-domain`, so the
 * plan shown and the assessment written cannot disagree. The only thing the server adds on
 * top is feasibility, which is a fact about the bank and not about the role.
 *
 * ## Feasibility is reported, never enforced by silence
 *
 * A rule asking for six Python questions at difficulty 2–4 when the bank has four is
 * infeasible, and the honest response is to say so with both numbers, not to quietly serve
 * four. `resolveDraw` refuses to short-draw for the same reason (ADR-004): a section that
 * served four where the rule said five scores that candidate out of a different denominator,
 * and nobody notices until the appeal.
 *
 * So the plan carries `feasible` and a shortfall per rule that cannot be met, and the create
 * endpoint refuses an infeasible composition rather than writing an assessment that cannot
 * be sat.
 */

import { z } from 'zod';

import { AssessmentIdSchema, JobRoleIdSchema, SkillIdSchema } from './ids.js';
import { Rfc3339Schema } from './primitives.js';
import { QuestionKindSchema } from './questions.js';

/** OpenAPI spellings; `apps/api` prefixes `API_BASE_PATH`. */
export const ASSESSMENTS_PATH = '/assessments';
export const ASSESSMENT_PATH = '/assessments/{id}';
/**
 * Compose from a role and save.
 *
 * `/assessments/auto`, not `POST /assessments`, because docs/03 §5 already reserves the
 * latter for creating one by hand — name, duration, settings, no questions — and a
 * body-shape discriminator on one path would be two endpoints wearing one URL. Nothing
 * creates an assessment by hand yet; the path is kept free for when something does.
 */
export const ASSESSMENT_AUTO_PATH = '/assessments/auto';
export const JOB_ROLE_ASSESSMENT_PLAN_PATH = '/job-roles/{id}/assessment-plan';

/**
 * Seconds allowed per question when the caller does not say.
 *
 * Five minutes. It is a default and not a rule: `est_seconds` on a question version is the
 * author's own estimate and varies from 120 to 1,800, so a duration derived from the actual
 * draw would be more accurate and cannot be computed before the draw happens — the draw is
 * per candidate, at attempt start (ADR-004). Five minutes is the round number a recruiter can
 * sanity-check against the paper in front of them, and the field is editable.
 */
export const DEFAULT_SECONDS_PER_QUESTION = 300;

/** Questions per required skill when the caller does not say. */
export const DEFAULT_QUESTIONS_PER_SKILL = 2;

/** The most questions one assessment may hold. A bound on the draw, not a product opinion. */
export const MAX_QUESTION_COUNT = 100;

/** What a composition is asked for. Every field optional: a role is enough on its own. */
export const AssessmentPlanQuerySchema = z
  .strictObject({
    question_count: z.coerce.number().int().min(1).max(MAX_QUESTION_COUNT).optional(),
    duration_seconds: z.coerce
      .number()
      .int()
      .min(60)
      .max(8 * 60 * 60)
      .optional(),
    /** Restrict the whole paper to one kind. Absent means any kind the bank holds. */
    kind: QuestionKindSchema.optional(),
    /** Exclude questions this candidate saw in the last N days. Zero disables it. */
    exclude_seen_days: z.coerce.number().int().min(0).max(3650).optional(),
  })
  .describe('How to compose. A role alone is sufficient; every field has a documented default.');

export type AssessmentPlanQuery = z.infer<typeof AssessmentPlanQuerySchema>;

/** One rule of the plan: what it asks for, and what the bank actually holds for it. */
export const PlannedRuleSchema = z
  .object({
    skill_id: SkillIdSchema,
    skill_name: z.string(),
    pick_count: z.number().int().min(1),
    min_difficulty: z.number().int().min(1).max(5),
    max_difficulty: z.number().int().min(1).max(5),
    /**
     * Published questions this rule could draw from, right now.
     *
     * The same number the coverage report shows, asked with this rule's filters rather than
     * the role's — they differ when the plan restricts kind.
     */
    available: z.number().int().min(0),
  })
  .describe('One section rule, with the size of the pool it would draw from.')
  .openapi('PlannedRule');

export type PlannedRule = z.infer<typeof PlannedRuleSchema>;

export const PlannedSectionSchema = z
  .object({ name: z.string(), rules: z.array(PlannedRuleSchema) })
  .openapi('PlannedSection');

export type PlannedSectionView = z.infer<typeof PlannedSectionSchema>;

export const AssessmentPlanSchema = z
  .object({
    job_role_id: JobRoleIdSchema,
    role_title: z.string(),
    question_count: z.number().int().min(1),
    duration_seconds: z.number().int().min(60),
    total_score: z.number(),
    sections: z.array(PlannedSectionSchema),
    /** True when every rule's `pick_count` is within its `available`. */
    feasible: z.boolean(),
  })
  .describe('What would be composed for this role, and whether the bank can supply it.')
  .openapi('AssessmentPlan');

export type AssessmentPlan = z.infer<typeof AssessmentPlanSchema>;

/** The body of `POST /assessments/auto`. */
export const CreateAssessmentSchema = z
  .strictObject({
    job_role_id: JobRoleIdSchema,
    /** Defaults to the role's title, which is what a recruiter would have typed. */
    name: z.string().min(1).max(200).optional(),
    question_count: z.number().int().min(1).max(MAX_QUESTION_COUNT).optional(),
    duration_seconds: z
      .number()
      .int()
      .min(60)
      .max(8 * 60 * 60)
      .optional(),
    kind: QuestionKindSchema.optional(),
    exclude_seen_days: z.number().int().min(0).max(3650).optional(),
  })
  .describe('Compose and save an assessment for a role.')
  .openapi('CreateAssessment');

export type CreateAssessment = z.infer<typeof CreateAssessmentSchema>;

export const AssessmentSchema = z
  .object({
    id: AssessmentIdSchema,
    job_role_id: JobRoleIdSchema.nullable(),
    name: z.string(),
    duration_seconds: z.number().int(),
    status: z.string(),
    question_count: z.number().int(),
    created_at: Rfc3339Schema,
  })
  .describe('An assessment, as a list row.')
  .openapi('Assessment');

export type AssessmentView = z.infer<typeof AssessmentSchema>;

export const AssessmentListResponseSchema = z
  .object({ data: z.array(AssessmentSchema) })
  .describe('Every assessment the organisation has composed.')
  .openapi('AssessmentListResponse');

export type AssessmentListResponse = z.infer<typeof AssessmentListResponseSchema>;
