/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, job roles, and the join between them (ADR-009).
 *
 * The shape of this module encodes the decision: a question is tagged with **skills**, and a
 * job role declares which skills it needs. Nothing here lets a question reference a job role,
 * because that is the model ADR-009 rejects — with 500 questions and 15 roles, adding a role
 * would mean revisiting every question, and the tags drift out of date the same week.
 *
 * Difficulty is 1–5 throughout, matching the `CHECK` constraints in the schema. Weight is
 * `numeric(4,2)` in the database and arrives here as a number; it is not a percentage and does
 * not need to sum to anything.
 */

import { z } from 'zod';

import { SkillIdSchema } from './ids.js';
// Difficulty is defined once, in questions.ts, because a second definition of the same
// 1-5 band is a place for the two to drift apart.
import { DifficultySchema } from './questions.js';

/**
 * A skill key. Lower-case, dot-separated segments: `python`, `sql.window-functions`.
 *
 * Constrained rather than free text because ADR-009's named risk is taxonomy rot — a bank
 * carrying `python`, `python3` and `Python` as three skills is worse than no taxonomy at all.
 * Case folding is the cheapest of the defences; `mergeSkills` is the one that handles the rest.
 */
export const SkillKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u,
    'a skill key is lower-case alphanumeric with . or - separators, e.g. sql.window-functions',
  );

export const SkillCategorySchema = z.string().min(1).max(60);

export const CreateSkillSchema = z.object({
  key: SkillKeySchema,
  name: z.string().min(1).max(200),
  category: SkillCategorySchema.optional(),
  parent_id: SkillIdSchema.optional(),
});
export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;

export const UpdateSkillSchema = CreateSkillSchema.partial().omit({ key: true });
export type UpdateSkillInput = z.infer<typeof UpdateSkillSchema>;

export const ListSkillsQuerySchema = z.object({
  category: SkillCategorySchema.optional(),
  parent_id: SkillIdSchema.optional(),
});

/**
 * Merging one skill into another.
 *
 * A merge rewrites every `question_skills` and `job_role_skills` row pointing at `source` to
 * point at `target`, then archives `source`. It is audited and it requires a reason, because it
 * is lossy: after a merge, nothing records that the two were ever distinct. That is the point —
 * an unmerged duplicate quietly splits a role's coverage in half.
 */
export const MergeSkillSchema = z.object({
  target_id: SkillIdSchema,
  reason: z.string().min(1).max(500),
});
export type MergeSkillInput = z.infer<typeof MergeSkillSchema>;

export const CreateJobRoleSchema = z.object({
  code: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  family: z.string().min(1).max(60).optional(),
  seniority: z.string().min(1).max(60).optional(),
  description: z.string().max(5000).optional(),
});
export type CreateJobRoleInput = z.infer<typeof CreateJobRoleSchema>;

export const UpdateJobRoleSchema = CreateJobRoleSchema.partial()
  .omit({ code: true })
  .extend({ is_active: z.boolean().optional() });

/**
 * One row of a role's skill requirement.
 *
 * `min_difficulty <= max_difficulty` is enforced here rather than left to the database, so the
 * caller gets `validation_failed` naming the field instead of a constraint violation that says
 * only that something was wrong.
 */
export const JobRoleSkillSchema = z
  .object({
    skill_id: SkillIdSchema,
    weight: z.number().min(0).max(99.99),
    min_difficulty: DifficultySchema.optional(),
    max_difficulty: DifficultySchema.optional(),
    is_required: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.min_difficulty === undefined ||
      v.max_difficulty === undefined ||
      v.min_difficulty <= v.max_difficulty,
    { message: 'min_difficulty must not exceed max_difficulty', path: ['min_difficulty'] },
  );
export type JobRoleSkillInput = z.infer<typeof JobRoleSkillSchema>;

/** The whole requirement set is replaced at once — PUT, not PATCH, per docs/03 §3. */
export const PutJobRoleSkillsSchema = z.array(JobRoleSkillSchema).max(200);

export const ListJobRolesQuerySchema = z.object({
  family: z.string().min(1).max(60).optional(),
  seniority: z.string().min(1).max(60).optional(),
  active: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------- coverage

/**
 * Bank coverage for one required skill of a role.
 *
 * `published` counts only published versions, because a draft cannot be served to a candidate
 * and counting it would report a bank that does not exist. `by_difficulty` is the useful part:
 * a role needing difficulty 4–5 is not served by thirty questions at difficulty 1.
 */
export interface SkillCoverage {
  readonly skill_id: string;
  readonly skill_key: string;
  readonly skill_name: string;
  readonly is_required: boolean;
  readonly weight: number;
  readonly min_difficulty: number | null;
  readonly max_difficulty: number | null;
  /** Published questions in the requested band. The number that decides feasibility. */
  readonly in_band: number;
  /** Published questions tagged with this skill at any difficulty. */
  readonly published: number;
  readonly by_difficulty: Readonly<Record<'1' | '2' | '3' | '4' | '5', number>>;
}

/**
 * Whether a role can be assessed from the bank as it stands, and where it cannot.
 *
 * This is the report that stops a recruiter building an assessment against a role the bank
 * cannot support. It is advisory and it never blocks: the judgement about how thin is too thin
 * belongs to a person, and `POST /assessments/{id}/simulate` (P3) is what actually refuses.
 */
export interface JobRoleCoverage {
  readonly job_role_id: string;
  readonly generated_at: string;
  readonly skills: readonly SkillCoverage[];
  /** Required skills with no published question in band. Empty means nothing is missing. */
  readonly gaps: readonly string[];
}
