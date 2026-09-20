/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, job roles, tagging and coverage (docs/03 §3–4, ADR-009).
 *
 * The four steps P1 built are the same here as everywhere: the session became a principal, the
 * permission was checked before the handler ran, `request.audited` opens the one transaction
 * carrying both the change and its record, and `withOrg` inside it scopes the read to a tenant.
 *
 * Four things specific to this module are worth stating.
 *
 * **Every skill id a caller supplies is resolved under RLS before it is written.** A foreign key
 * is checked without row-level security, and `question_skills` and `job_role_skills` are policed
 * through the question and the role, not the skill. Without the check, one tenant could tag its
 * questions with another tenant's skill id and read that skill's name back through coverage.
 * An id the tenant cannot see is refused as not existing — never as forbidden, which would
 * confirm the id is real.
 *
 * **Merging is audited and carries a reason.** It is the only lossy operation in the taxonomy:
 * afterwards nothing records that the two skills were ever distinct.
 *
 * **Permissions follow who owns the vocabulary.** Skills and question tags are bank content, so
 * `question.write`. A job role's requirements decide what its assessments are composed from, so
 * `assessment.write`. Reading either needs `question.read`, as coverage always has.
 *
 * **Coverage is a read, and it never refuses.** It reports what the bank holds and leaves the
 * judgement to a person. The endpoint that blocks an infeasible assessment is
 * `POST /assessments/{id}/simulate`, which arrives in P3 (ADR-004).
 */

import type { FastifyInstance } from 'fastify';

import {
  ApiError,
  CreateJobRoleSchema,
  CreateSkillSchema,
  JOB_ROLES_PATH,
  JOB_ROLE_COVERAGE_PATH,
  JOB_ROLE_PATH,
  JOB_ROLE_SKILLS_PATH,
  JobRoleIdSchema,
  JobRoleParamsSchema,
  ListJobRolesQuerySchema,
  ListSkillsQuerySchema,
  MergeSkillSchema,
  PutJobRoleSkillsSchema,
  PutQuestionSkillsSchema,
  QUESTION_SKILLS_PATH,
  QuestionParamsSchema,
  SKILLS_PATH,
  SKILL_MERGE_PATH,
  SkillIdSchema,
  SkillParamsSchema,
  UpdateJobRoleSchema,
  parseRequestPart,
  type JobRoleCoverage,
  type JobRoleSkillView,
  type JobRoleView,
  type SkillCoverage,
} from '@assaybank/contracts';
import {
  createJobRole,
  createSkill,
  getJobRole,
  getJobRoleCoverage,
  getJobRoleSkills,
  getQuestionWithCurrentVersion,
  invisibleSkillIds,
  listJobRoles,
  listSkills,
  mergeSkills,
  setJobRoleSkills,
  setQuestionSkills,
  SkillMergeError,
  SkillNotFoundError,
  TaxonomyDepthError,
  updateJobRole,
  withOrg,
  type CoverageRow,
  type Database,
  type DbTransaction,
  type JobRoleRow,
  type JobRoleSkillRow,
} from '@assaybank/db';

import { requirePermission } from '../authorisation.js';
import { fastifyPath } from '../paths.js';
import { staffOnly } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';

export interface TaxonomyRouteOptions {
  readonly db: Database;
  readonly now: () => Date;
}

/** The registered paths, exported so the tests address the routes by the same constant. */
export const SKILLS_ROUTE = fastifyPath(SKILLS_PATH);
export const SKILL_MERGE_ROUTE = fastifyPath(SKILL_MERGE_PATH);
export const JOB_ROLES_ROUTE = fastifyPath(JOB_ROLES_PATH);
export const JOB_ROLE_ROUTE = fastifyPath(JOB_ROLE_PATH);
export const JOB_ROLE_SKILLS_ROUTE = fastifyPath(JOB_ROLE_SKILLS_PATH);
export const JOB_ROLE_COVERAGE_ROUTE = fastifyPath(JOB_ROLE_COVERAGE_PATH);
export const QUESTION_SKILLS_ROUTE = fastifyPath(QUESTION_SKILLS_PATH);

export const TAXONOMY_ACTIONS = {
  skillCreate: 'skill.create',
  skillMerge: 'skill.merge',
  jobRoleCreate: 'job_role.create',
  jobRoleUpdate: 'job_role.update',
  jobRoleSkillsReplace: 'job_role.skills.replace',
  questionSkillsReplace: 'question.skills.replace',
} as const;

const SKILL_ENTITY = 'skill';
const JOB_ROLE_ENTITY = 'job_role';
const QUESTION_ENTITY = 'question';

// ---------------------------------------------------------------------------- views

// The two views below mint branded ids by parsing rather than by casting. The rows come
// from our own database so the value is a UUID either way, and the cost is a regex per row
// on a list that holds tens of entries — but a cast here would be the one place the brand
// is asserted rather than established, which is the place it would eventually be wrong.
function toJobRoleView(row: JobRoleRow): JobRoleView {
  return {
    id: JobRoleIdSchema.parse(row.id),
    code: row.code,
    title: row.title,
    family: row.family,
    seniority: row.seniority,
    description: row.description,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

function toJobRoleSkillView(row: JobRoleSkillRow): JobRoleSkillView {
  return {
    skill_id: row.skillId,
    skill_key: row.skillKey,
    skill_name: row.skillName,
    weight: row.weight,
    min_difficulty: row.minDifficulty,
    max_difficulty: row.maxDifficulty,
    is_required: row.isRequired,
  };
}

function toCoverageView(row: CoverageRow): SkillCoverage {
  return {
    skill_id: SkillIdSchema.parse(row.skillId),
    skill_key: row.skillKey,
    skill_name: row.skillName,
    is_required: row.isRequired,
    weight: row.weight,
    min_difficulty: row.minDifficulty,
    max_difficulty: row.maxDifficulty,
    in_band: row.inBand,
    published: row.published,
    by_difficulty: row.byDifficulty,
  };
}

/**
 * Audit payloads are objects. A role's view is spread into one; a requirement set is wrapped,
 * so the row reads `{skills: [...]}` rather than a bare array nothing can add a field to later.
 */
const auditRole = (row: JobRoleRow): Record<string, unknown> => ({ ...toJobRoleView(row) });
const auditSkills = (skills: readonly object[]): Record<string, unknown> => ({ skills });

// ---------------------------------------------------------------------------- refusals

/** A body field that names something the refusal is about. */
function fieldRefusal(message: string, field: string, rule: string): ApiError {
  return ApiError.validationFailed(message, {
    details: { fields: [{ field, rule, message }] },
  });
}

/**
 * Refuses a body naming any skill this tenant cannot read, naming each by its position.
 *
 * `422` and not `404`: the URL's resource exists; what is wrong is a value in the body.
 */
async function assertSkillsVisible(
  tx: DbTransaction,
  rows: readonly { readonly skill_id: string }[],
): Promise<void> {
  const invisible = new Set(
    await invisibleSkillIds(
      tx,
      rows.map((r) => r.skill_id),
    ),
  );
  if (invisible.size === 0) return;
  const message = 'No such skill.';
  throw ApiError.validationFailed('A skill in the body does not exist.', {
    details: {
      fields: rows.flatMap((row, index) =>
        invisible.has(row.skill_id)
          ? [{ field: `body/${String(index)}/skill_id`, rule: 'not_found', message }]
          : [],
      ),
    },
  });
}

async function requireJobRole(
  tx: DbTransaction,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<JobRoleRow> {
  const role = await getJobRole(tx, id, options);
  if (role === undefined) throw ApiError.notFound();
  return role;
}

export function registerTaxonomyRoutes(app: FastifyInstance, options: TaxonomyRouteOptions): void {
  const { db, now } = options;

  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const writeBank = { ...rateLimitFor('staff_api'), ...requirePermission('question.write') };
  const writeRoles = { ...rateLimitFor('staff_api'), ...requirePermission('assessment.write') };

  // --- GET /skills -------------------------------------------------------------
  app.get(SKILLS_ROUTE, { config: read }, async (request) => {
    const principal = staffOnly(request);
    const query = parseRequestPart(ListSkillsQuerySchema, request.query, 'querystring');

    const rows = await withOrg(db, principal.orgId, (tx) =>
      listSkills(tx, { category: query.category, parentId: query.parent_id }),
    );

    return {
      data: rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        category: r.category,
        parent_id: r.parentId,
        // Null org_id is the shared global taxonomy. Surfaced rather than hidden, because an
        // org cannot edit a global skill and the console needs to know that before offering to.
        is_global: r.orgId === null,
      })),
    };
  });

  // --- POST /skills ------------------------------------------------------------
  app.post(SKILLS_ROUTE, { config: writeBank }, async (request, reply) => {
    const principal = staffOnly(request);
    const body = parseRequestPart(CreateSkillSchema, request.body, 'body');

    const created = await request.audited(
      { action: TAXONOMY_ACTIONS.skillCreate, entityType: SKILL_ENTITY },
      async (tx, entry) => {
        try {
          const skill = await createSkill(tx, {
            orgId: principal.orgId,
            key: body.key,
            name: body.name,
            ...(body.category === undefined ? {} : { category: body.category }),
            ...(body.parent_id === undefined ? {} : { parentId: body.parent_id }),
          });
          entry.amend({ entityId: skill.id });
          return skill;
        } catch (error) {
          if (error instanceof SkillNotFoundError) {
            throw fieldRefusal('No such parent skill.', 'body/parent_id', 'not_found');
          }
          if (error instanceof TaxonomyDepthError) {
            throw fieldRefusal(error.message, 'body/parent_id', 'too_deep');
          }
          throw error;
        }
      },
    );

    reply.code(201);
    return { id: created.id, key: created.key, name: created.name, category: created.category };
  });

  // --- POST /skills/:id/merge --------------------------------------------------
  app.post(SKILL_MERGE_ROUTE, { config: writeBank }, async (request) => {
    // Called for the refusal, not the value: `request.audited` supplies the org-scoped
    // transaction, so nothing here needs the principal.
    staffOnly(request);
    const { id: sourceId } = parseRequestPart(SkillParamsSchema, request.params, 'params');
    const body = parseRequestPart(MergeSkillSchema, request.body, 'body');

    return request.audited(
      // The reason is carried into the audit entry rather than logged, because a merge is a
      // domain event a person may have to explain months later (FR-21).
      {
        action: TAXONOMY_ACTIONS.skillMerge,
        entityType: SKILL_ENTITY,
        entityId: sourceId,
        reason: body.reason,
      },
      async (tx) => {
        try {
          const result = await mergeSkills(tx, sourceId, body.target_id);
          return {
            merged_into: body.target_id,
            question_tags_rewritten: result.questionTagsRewritten,
            role_requirements_rewritten: result.roleRequirementsRewritten,
            children_reparented: result.childrenReparented,
          };
        } catch (error) {
          if (error instanceof SkillNotFoundError) {
            // The source is the URL's resource; the target is a value in the body.
            if (error.skillId === sourceId) throw ApiError.notFound();
            throw fieldRefusal('No such skill.', 'body/target_id', 'not_found');
          }
          if (error instanceof SkillMergeError || error instanceof TaxonomyDepthError) {
            throw fieldRefusal(error.message, 'body/target_id', 'merge_refused');
          }
          throw error;
        }
      },
    );
  });

  // --- GET /job-roles ----------------------------------------------------------
  app.get(JOB_ROLES_ROUTE, { config: read }, async (request) => {
    const principal = staffOnly(request);
    const query = parseRequestPart(ListJobRolesQuerySchema, request.query, 'querystring');

    const rows = await withOrg(db, principal.orgId, (tx) =>
      listJobRoles(tx, { family: query.family, seniority: query.seniority, active: query.active }),
    );
    return { data: rows.map(toJobRoleView) };
  });

  // --- POST /job-roles ---------------------------------------------------------
  app.post(
    JOB_ROLES_ROUTE,
    { config: writeRoles },
    async (request, reply): Promise<JobRoleView> => {
      const principal = staffOnly(request);
      const body = parseRequestPart(CreateJobRoleSchema, request.body, 'body');

      const created = await request.audited(
        { action: TAXONOMY_ACTIONS.jobRoleCreate, entityType: JOB_ROLE_ENTITY },
        async (tx, entry) => {
          const role = await createJobRole(tx, {
            orgId: principal.orgId,
            code: body.code,
            title: body.title,
            family: body.family,
            seniority: body.seniority,
            description: body.description,
          });
          if (role === undefined) {
            throw ApiError.conflict('A job role with this code already exists.', {
              details: { field: 'body/code', code: body.code },
            });
          }
          entry.amend({ entityId: role.id, after: auditRole(role) });
          return role;
        },
      );

      reply.code(201);
      return toJobRoleView(created);
    },
  );

  // --- GET /job-roles/:id ------------------------------------------------------
  app.get(JOB_ROLE_ROUTE, { config: read }, async (request): Promise<JobRoleView> => {
    const principal = staffOnly(request);
    const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');
    return toJobRoleView(await withOrg(db, principal.orgId, (tx) => requireJobRole(tx, id)));
  });

  // --- PATCH /job-roles/:id ----------------------------------------------------
  app.patch(JOB_ROLE_ROUTE, { config: writeRoles }, async (request): Promise<JobRoleView> => {
    staffOnly(request);
    const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');
    const patch = parseRequestPart(UpdateJobRoleSchema, request.body, 'body');

    const updated = await request.audited(
      { action: TAXONOMY_ACTIONS.jobRoleUpdate, entityType: JOB_ROLE_ENTITY, entityId: id },
      async (tx, entry) => {
        const before = await requireJobRole(tx, id, { forUpdate: true });
        const after = await updateJobRole(tx, id, {
          title: patch.title,
          family: patch.family,
          seniority: patch.seniority,
          description: patch.description,
          isActive: patch.is_active,
        });
        if (after === undefined) throw ApiError.notFound();
        entry.amend({ before: auditRole(before), after: auditRole(after) });
        return after;
      },
    );
    return toJobRoleView(updated);
  });

  // --- GET /job-roles/:id/skills -----------------------------------------------
  app.get(JOB_ROLE_SKILLS_ROUTE, { config: read }, async (request) => {
    const principal = staffOnly(request);
    const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');

    const rows = await withOrg(db, principal.orgId, async (tx) => {
      await requireJobRole(tx, id);
      return getJobRoleSkills(tx, id);
    });
    return { job_role_id: id, data: rows.map(toJobRoleSkillView) };
  });

  // --- PUT /job-roles/:id/skills -----------------------------------------------
  app.put(JOB_ROLE_SKILLS_ROUTE, { config: writeRoles }, async (request) => {
    staffOnly(request);
    const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');
    const body = parseRequestPart(PutJobRoleSkillsSchema, request.body, 'body');

    const rows = await request.audited(
      { action: TAXONOMY_ACTIONS.jobRoleSkillsReplace, entityType: JOB_ROLE_ENTITY, entityId: id },
      async (tx, entry) => {
        // Locks the role so two editors replacing its requirements at once serialise rather
        // than interleave a delete and two inserts.
        await requireJobRole(tx, id, { forUpdate: true });
        await assertSkillsVisible(tx, body);
        const before = await getJobRoleSkills(tx, id);
        await setJobRoleSkills(
          tx,
          id,
          body.map((row) => ({
            skillId: row.skill_id,
            weight: row.weight,
            minDifficulty: row.min_difficulty,
            maxDifficulty: row.max_difficulty,
            isRequired: row.is_required,
          })),
        );
        const after = await getJobRoleSkills(tx, id);
        entry.amend({
          before: auditSkills(before.map(toJobRoleSkillView)),
          after: auditSkills(after.map(toJobRoleSkillView)),
        });
        return after;
      },
    );
    return { job_role_id: id, data: rows.map(toJobRoleSkillView) };
  });

  // --- GET /job-roles/:id/coverage ---------------------------------------------
  app.get(JOB_ROLE_COVERAGE_ROUTE, { config: read }, async (request): Promise<JobRoleCoverage> => {
    const principal = staffOnly(request);
    const { id } = parseRequestPart(JobRoleParamsSchema, request.params, 'params');

    const rows = await withOrg(db, principal.orgId, async (tx) => {
      // A role that does not exist is a 404, not an empty report: "no requirements, no gaps"
      // for a mistyped id is a clean bill of health for something that is not there.
      await requireJobRole(tx, id);
      return getJobRoleCoverage(tx, id);
    });
    const skills = rows.map(toCoverageView);

    return {
      job_role_id: id,
      generated_at: now().toISOString(),
      skills,
      // A required skill with nothing in band. Named explicitly so a caller does not have to
      // re-derive the rule, and so "no gaps" is an assertion rather than an empty-looking list.
      gaps: skills.filter((s) => s.is_required && s.in_band === 0).map((s) => s.skill_key),
    };
  });

  // --- PUT /questions/:id/skills -----------------------------------------------
  //
  // Here rather than in questions/routes.ts because what it validates is taxonomy: the skills
  // must be visible to the tenant. Tags live on the question, not the version, so tagging a
  // published question is allowed and changes nothing a candidate was served (ADR-003).
  app.put(QUESTION_SKILLS_ROUTE, { config: writeBank }, async (request) => {
    staffOnly(request);
    const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');
    const body = parseRequestPart(PutQuestionSkillsSchema, request.body, 'body');

    const skills = await request.audited(
      { action: TAXONOMY_ACTIONS.questionSkillsReplace, entityType: QUESTION_ENTITY, entityId: id },
      async (tx, entry) => {
        const before = await getQuestionWithCurrentVersion(tx, id, { forUpdate: true });
        if (before === undefined) throw ApiError.notFound();
        await assertSkillsVisible(tx, body);
        await setQuestionSkills(
          tx,
          id,
          body.map((row) => ({ skillId: row.skill_id, weight: row.weight })),
        );
        const after = await getQuestionWithCurrentVersion(tx, id);
        if (after === undefined) throw ApiError.notFound();
        entry.amend({ before: auditSkills(before.skills), after: auditSkills(after.skills) });
        return after.skills;
      },
    );
    return {
      question_id: id,
      skills: skills.map((s) => ({ skill_id: s.skill_id, weight: s.weight })),
    };
  });
}
