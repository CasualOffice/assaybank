/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, job roles and coverage (docs/03 §3, ADR-009).
 *
 * The four steps P1 built are the same here as everywhere: the session became a principal, the
 * permission was checked before the handler ran, `request.audited` opens the one transaction
 * carrying both the change and its record, and `withOrg` inside it scopes the read to a tenant.
 *
 * Two things specific to this module are worth stating.
 *
 * **Merging is audited and carries a reason.** It is the only lossy operation in the taxonomy:
 * afterwards nothing records that the two skills were ever distinct. ADR-009 names taxonomy rot
 * as the standing risk, so merging has to be easy — but easy and unrecorded is how a bank loses
 * the history of its own vocabulary.
 *
 * **Coverage is a read, and it never refuses.** It reports what the bank holds and leaves the
 * judgement to a person. The endpoint that actually blocks an infeasible assessment is
 * `POST /assessments/{id}/simulate`, which arrives in P3 (ADR-004).
 */

import type { FastifyInstance } from 'fastify';

import {
  CreateSkillSchema,
  ListSkillsQuerySchema,
  MergeSkillSchema,
  SkillIdSchema,
  parseRequestPart,
  type JobRoleCoverage,
  type SkillCoverage,
} from '@assaybank/contracts';
import {
  createSkill,
  getJobRoleCoverage,
  listSkills,
  mergeSkills,
  TaxonomyDepthError,
  withOrg,
  type CoverageRow,
  type Database,
} from '@assaybank/db';

import { requirePermission } from '../authorisation.js';
import { staffOnly } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';

export interface TaxonomyRouteOptions {
  readonly db: Database;
  readonly now: () => Date;
}

const SKILLS_ROUTE = '/skills';
const SKILL_MERGE_ROUTE = '/skills/:id/merge';
const ROLE_COVERAGE_ROUTE = '/job-roles/:id/coverage';

const SKILL_ENTITY = 'skill';
const SKILL_ACTIONS = { create: 'skill.create', merge: 'skill.merge' } as const;

function toCoverageView(row: CoverageRow): SkillCoverage {
  return {
    skill_id: row.skillId,
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

export function registerTaxonomyRoutes(app: FastifyInstance, options: TaxonomyRouteOptions): void {
  const { db, now } = options;

  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const write = { ...rateLimitFor('staff_api'), ...requirePermission('question.write') };

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
  app.post(SKILLS_ROUTE, { config: write }, async (request, reply) => {
    const principal = staffOnly(request);
    const body = parseRequestPart(CreateSkillSchema, request.body, 'body');

    const created = await request.audited(
      { action: SKILL_ACTIONS.create, entityType: SKILL_ENTITY },
      async (tx, entry) => {
        const skill = await createSkill(tx, {
          orgId: principal.orgId,
          key: body.key,
          name: body.name,
          ...(body.category === undefined ? {} : { category: body.category }),
          ...(body.parent_id === undefined ? {} : { parentId: body.parent_id }),
        });
        entry.amend({ entityId: skill.id });
        return skill;
      },
    );

    reply.code(201);
    return { id: created.id, key: created.key, name: created.name, category: created.category };
  });

  // --- POST /skills/:id/merge --------------------------------------------------
  app.post(SKILL_MERGE_ROUTE, { config: write }, async (request) => {
    // Called for the refusal, not the value: `request.audited` supplies the org-scoped
    // transaction, so nothing here needs the principal. Dropping the call would still
    // work today and would stop working the day somebody moves this onto the public
    // allow-list, which is exactly the day nobody is looking.
    staffOnly(request);
    const sourceId = parseRequestPart(SkillIdSchema, (request.params as { id: string }).id, 'params');
    const body = parseRequestPart(MergeSkillSchema, request.body, 'body');

    return request.audited(
      // The reason is carried into the audit entry rather than logged, because a merge is a
      // domain event a person may have to explain months later (FR-21).
      { action: SKILL_ACTIONS.merge, entityType: SKILL_ENTITY, entityId: sourceId, reason: body.reason },
      async (tx) => {
        const result = await mergeSkills(tx, sourceId, body.target_id);
        return {
          merged_into: body.target_id,
          question_tags_rewritten: result.questionTagsRewritten,
          role_requirements_rewritten: result.roleRequirementsRewritten,
          children_reparented: result.childrenReparented,
        };
      },
    );
  });

  // --- GET /job-roles/:id/coverage ---------------------------------------------
  app.get(ROLE_COVERAGE_ROUTE, { config: read }, async (request): Promise<JobRoleCoverage> => {
    const principal = staffOnly(request);
    const jobRoleId = (request.params as { id: string }).id;

    const rows = await withOrg(db, principal.orgId, (tx) => getJobRoleCoverage(tx, jobRoleId));
    const skills = rows.map(toCoverageView);

    return {
      job_role_id: jobRoleId,
      generated_at: now().toISOString(),
      skills,
      // A required skill with nothing in band. Named explicitly so a caller does not have to
      // re-derive the rule, and so "no gaps" is an assertion rather than an empty-looking list.
      gaps: skills.filter((s) => s.is_required && s.in_band === 0).map((s) => s.skill_key),
    };
  });
}

export { TaxonomyDepthError };
