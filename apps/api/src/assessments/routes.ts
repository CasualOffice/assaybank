/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing an assessment from a role (`H-179`, docs/03 §5, docs/18 §2.2).
 *
 * ```
 * GET  /job-roles/{id}/assessment-plan   → what would be composed, and can the bank supply it
 * POST /assessments/auto                 → compose the same thing and save it
 * GET  /assessments                      → what has been composed
 * ```
 *
 * ## One composer, two endpoints
 *
 * The plan and the create both call `composeFromRole`. That is the whole point of it being a
 * pure function in `packages/core-domain`: a preview that computed the paper differently from
 * the save would be a preview of something else, and the difference would show up as a
 * candidate sitting a paper nobody reviewed.
 *
 * The plan is a `GET` because looking should be free. A preview that wrote a draft would
 * leave one behind for every recruiter who opened the screen and changed their mind.
 *
 * ## Feasibility is checked here, because it is the only layer that can
 *
 * `composeFromRole` is pure and cannot ask the bank anything; `countAvailable` asks the bank
 * and knows nothing about roles. This route is where a rule asking for six Python questions
 * meets the four the bank actually holds — it reports the shortfall on the plan, and refuses
 * the create.
 *
 * Refusing matters more than it looks. `resolveDraw` will not short-draw at attempt start
 * (ADR-004), so an infeasible assessment is not one that degrades — it is one that fails for
 * the first candidate who clicks the link, at the worst possible moment. Better to refuse it
 * while somebody is looking at the screen.
 *
 * The check is a snapshot and is deliberately not recorded as a guarantee: the bank changes,
 * and an assessment feasible on Tuesday can be infeasible on Friday if questions are retired.
 * The durable check is the one at attempt start.
 */

import type { FastifyInstance } from 'fastify';

import {
  ApiError,
  ASSESSMENTS_PATH,
  ASSESSMENT_AUTO_PATH,
  AssessmentPlanQuerySchema,
  CreateAssessmentSchema,
  DEFAULT_QUESTIONS_PER_SKILL,
  DEFAULT_SECONDS_PER_QUESTION,
  JOB_ROLE_ASSESSMENT_PLAN_PATH,
  JobRoleParamsSchema,
  MAX_QUESTION_COUNT,
  parseRequestPart,
  type AssessmentListResponse,
  type AssessmentPlan,
  type AssessmentView,
  type PlannedSectionView,
} from '@assaybank/contracts';
import { composeFromRole, type Composition, type RoleSkill } from '@assaybank/core-domain';
import {
  countAvailable,
  createAssessment,
  getJobRole,
  getJobRoleSkills,
  listAssessments,
  withOrg,
  type Database,
  type DbTransaction,
} from '@assaybank/db';

import { currentPrincipal } from '../principal.js';
import { fastifyPath } from '../paths.js';
import { rateLimitFor } from '../rate-limit.js';
import { requirePermission } from '../authorisation.js';

export const ASSESSMENTS_ROUTE = fastifyPath(ASSESSMENTS_PATH);
export const ASSESSMENT_AUTO_ROUTE = fastifyPath(ASSESSMENT_AUTO_PATH);
export const JOB_ROLE_ASSESSMENT_PLAN_ROUTE = fastifyPath(JOB_ROLE_ASSESSMENT_PLAN_PATH);

/** What these routes need. */
export interface AssessmentServices {
  readonly db: Database;
}

/** The audit action for composing one. */
export const ASSESSMENT_CREATE_ACTION = 'assessment.create';
const ASSESSMENT_ENTITY = 'assessment';

function staffOnly(request: Parameters<typeof currentPrincipal>[0]) {
  const principal = currentPrincipal(request);
  if (principal.kind !== 'staff') throw ApiError.unauthenticated();
  return principal;
}

/**
 * Everything a composition needs from the database, for one role.
 *
 * A 404 for a role that does not exist rather than an empty plan: "an assessment with no
 * questions" is a strange but plausible-looking answer to a mistyped id, and it would be
 * acted on.
 */
async function roleAndSkills(
  tx: DbTransaction,
  jobRoleId: string,
): Promise<{ title: string; skills: RoleSkill[] }> {
  const role = await getJobRole(tx, jobRoleId);
  if (role === undefined) throw ApiError.notFound();

  const rows = await getJobRoleSkills(tx, jobRoleId);
  return {
    title: role.title,
    skills: rows.map((row) => ({
      skillId: row.skillId,
      skillName: row.skillName,
      weight: row.weight,
      minDifficulty: row.minDifficulty,
      maxDifficulty: row.maxDifficulty,
      isRequired: row.isRequired,
    })) as RoleSkill[],
  };
}

/** How big a paper to compose when the caller did not say. */
function defaultQuestionCount(skills: readonly RoleSkill[]): number {
  const required = skills.filter((skill) => skill.isRequired).length;
  // Two per required skill: one question measures whether somebody can do a thing at all,
  // and two is the smallest number that distinguishes a lucky guess from a pattern. Bounded,
  // because a role with sixty required skills is a role that needs fixing, not a paper of
  // 120 questions.
  return Math.min(Math.max(required * DEFAULT_QUESTIONS_PER_SKILL, 1), MAX_QUESTION_COUNT);
}

/** Runs the composer, turning its refusal into the API's vocabulary. */
function compose(skills: readonly RoleSkill[], options: Parameters<typeof composeFromRole>[1]) {
  const result = composeFromRole(skills, options);
  if (!result.ok) {
    // The composer refuses for reasons that are all about what the *caller asked for* —
    // too few questions for the role, a role with no required skill — so they are the
    // caller's to fix and `validation_failed` is the honest code.
    throw ApiError.validationFailed(result.error.message);
  }
  return result.value;
}

/** Pairs each composed rule with the size of the pool it would draw from. */
async function withAvailability(
  tx: DbTransaction,
  composition: Composition,
): Promise<{ sections: PlannedSectionView[]; feasible: boolean }> {
  const sections: PlannedSectionView[] = [];
  let feasible = true;

  for (const section of composition.sections) {
    const rules = [];
    for (const rule of section.rules) {
      const skillId = rule.skillIds[0];
      const available =
        skillId === undefined
          ? 0
          : await countAvailable(tx, {
              skillId,
              kinds: rule.kinds,
              minDifficulty: rule.minDifficulty,
              maxDifficulty: rule.maxDifficulty,
            });

      if (available < rule.pickCount) feasible = false;

      rules.push({
        skill_id: skillId ?? '',
        skill_name: rule.skillName,
        pick_count: rule.pickCount,
        min_difficulty: rule.minDifficulty,
        max_difficulty: rule.maxDifficulty,
        available,
      });
    }
    sections.push({ name: section.name, rules } as PlannedSectionView);
  }

  return { sections, feasible };
}

export function registerAssessmentRoutes(app: FastifyInstance, services: AssessmentServices): void {
  const { db } = services;
  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const write = { ...rateLimitFor('staff_api'), ...requirePermission('assessment.write') };

  // --- GET /job-roles/:id/assessment-plan --------------------------------------
  app.get(
    JOB_ROLE_ASSESSMENT_PLAN_ROUTE,
    { config: read },
    async (request): Promise<AssessmentPlan> => {
      const principal = staffOnly(request);
      const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');
      const query = parseRequestPart(AssessmentPlanQuerySchema, request.query ?? {}, 'querystring');

      return withOrg(db, principal.orgId, async (tx) => {
        const { title, skills } = await roleAndSkills(tx, id);
        const questionCount = query.question_count ?? defaultQuestionCount(skills);

        const composition = compose(skills, {
          questionCount,
          ...(query.kind === undefined ? {} : { kinds: [query.kind] }),
          ...(query.exclude_seen_days === undefined
            ? {}
            : { excludeSeenDays: query.exclude_seen_days }),
        });

        const { sections, feasible } = await withAvailability(tx, composition);

        return {
          job_role_id: id,
          role_title: title,
          question_count: composition.questionCount,
          duration_seconds:
            query.duration_seconds ?? composition.questionCount * DEFAULT_SECONDS_PER_QUESTION,
          total_score: composition.totalScore,
          sections,
          feasible,
        };
      });
    },
  );

  // --- POST /assessments/auto --------------------------------------------------
  app.post(ASSESSMENT_AUTO_ROUTE, { config: write }, async (request, reply) => {
    staffOnly(request);
    const body = parseRequestPart(CreateAssessmentSchema, request.body, 'body');

    const created = await request.audited(
      { action: ASSESSMENT_CREATE_ACTION, entityType: ASSESSMENT_ENTITY },
      async (tx, entry) => {
        const principal = staffOnly(request);
        const { title, skills } = await roleAndSkills(tx, body.job_role_id);
        const questionCount = body.question_count ?? defaultQuestionCount(skills);

        const composition = compose(skills, {
          questionCount,
          ...(body.kind === undefined ? {} : { kinds: [body.kind] }),
          ...(body.exclude_seen_days === undefined
            ? {}
            : { excludeSeenDays: body.exclude_seen_days }),
        });

        const { sections, feasible } = await withAvailability(tx, composition);
        if (!feasible) {
          // See the module note: an infeasible assessment does not degrade, it fails for
          // the first candidate who opens it. The detail names every rule that cannot be
          // met, so the screen can say which skills to go and write questions for.
          throw ApiError.validationFailed(
            'The bank cannot supply this assessment. Publish more questions for the skills below, or ask for fewer.',
            {
              details: {
                shortfalls: sections
                  .flatMap((section) => section.rules)
                  .filter((rule) => rule.available < rule.pick_count)
                  .map((rule) => ({
                    skill_name: rule.skill_name,
                    needed: rule.pick_count,
                    available: rule.available,
                  })),
              },
            },
          );
        }

        const durationSeconds =
          body.duration_seconds ?? composition.questionCount * DEFAULT_SECONDS_PER_QUESTION;

        const id = await createAssessment(tx, {
          orgId: principal.orgId,
          jobRoleId: body.job_role_id,
          name: body.name ?? title,
          durationSeconds,
          createdBy: principal.userId,
          sections: composition.sections.map((section) => ({
            name: section.name,
            rules: section.rules.map((rule) => ({
              pickCount: rule.pickCount,
              skillIds: rule.skillIds,
              kinds: rule.kinds,
              minDifficulty: rule.minDifficulty,
              maxDifficulty: rule.maxDifficulty,
              excludeSeenDays: rule.excludeSeenDays,
              scorePerQuestion: rule.scorePerQuestion,
            })),
          })),
        });

        entry.amend({
          entityId: id,
          after: {
            job_role_id: body.job_role_id,
            question_count: composition.questionCount,
            duration_seconds: durationSeconds,
          },
        });

        return {
          id,
          job_role_id: body.job_role_id,
          name: body.name ?? title,
          duration_seconds: durationSeconds,
          status: 'draft',
          question_count: composition.questionCount,
          created_at: new Date().toISOString(),
        } as AssessmentView;
      },
    );

    return reply.code(201).send(created);
  });

  // --- GET /assessments --------------------------------------------------------
  app.get(ASSESSMENTS_ROUTE, { config: read }, async (request): Promise<AssessmentListResponse> => {
    const principal = staffOnly(request);

    const rows = await withOrg(db, principal.orgId, (tx) => listAssessments(tx));
    return {
      data: rows.map((row) => ({
        id: row.id,
        job_role_id: row.jobRoleId,
        name: row.name,
        duration_seconds: row.durationSeconds,
        status: row.status,
        question_count: row.questionCount,
        created_at: row.createdAt,
      })) as AssessmentView[],
    };
  });
}
