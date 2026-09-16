/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, job roles, and bank coverage (ADR-009).
 *
 * Every function here takes a transaction that `withOrg` has already scoped, so none of them
 * filters on `org_id` by hand. Row-level security is what makes the read see one tenant; a
 * `WHERE org_id = ...` added here as well would be belt-and-braces that hides a missing policy
 * rather than catching it.
 *
 * The one exception is `skills`, whose `org_id` is nullable: a null row is the shared global
 * taxonomy every organisation can read. The RLS policy admits both, which is why listing skills
 * returns org rows and global rows together and `key` is unique per `(org_id, key)` rather than
 * globally.
 */

import { sql } from 'drizzle-orm';

import type { DbTransaction } from './client.js';

export interface SkillRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly parentId: string | null;
  readonly key: string;
  readonly name: string;
  readonly category: string | null;
}

export interface ListSkillsFilter {
  readonly category?: string | undefined;
  readonly parentId?: string | undefined;
}

export async function listSkills(tx: DbTransaction, filter: ListSkillsFilter): Promise<SkillRow[]> {
  const rows = await tx.execute<{
    id: string;
    org_id: string | null;
    parent_id: string | null;
    key: string;
    name: string;
    category: string | null;
  }>(sql`
    SELECT id, org_id, parent_id, key, name, category
      FROM skills
     WHERE (${filter.category ?? null}::text IS NULL OR category = ${filter.category ?? null})
       AND (${filter.parentId ?? null}::uuid IS NULL OR parent_id = ${filter.parentId ?? null}::uuid)
     ORDER BY key
  `);
  return rows.map(toSkillRow);
}

function toSkillRow(r: {
  id: string;
  org_id: string | null;
  parent_id: string | null;
  key: string;
  name: string;
  category: string | null;
}): SkillRow {
  return {
    id: r.id,
    orgId: r.org_id,
    parentId: r.parent_id,
    key: r.key,
    name: r.name,
    category: r.category,
  };
}

export class TaxonomyDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyDepthError';
  }
}

/**
 * Creates a skill, refusing a third level.
 *
 * ADR-009: "Keep it shallow (two levels)". Depth is checked here rather than by a constraint
 * because expressing "the parent must itself have no parent" as a `CHECK` needs a subquery,
 * which Postgres does not allow in one. A trigger could, but the rule is a taxonomy-design
 * decision rather than a data-integrity one, and it is easier to read here.
 */
export async function createSkill(
  tx: DbTransaction,
  input: {
    orgId: string;
    key: string;
    name: string;
    category?: string | undefined;
    parentId?: string | undefined;
  },
): Promise<SkillRow> {
  if (input.parentId !== undefined) {
    const parent = await tx.execute<{ parent_id: string | null }>(sql`
      SELECT parent_id FROM skills WHERE id = ${input.parentId}::uuid
    `);
    const found = parent[0];
    if (found === undefined) {
      throw new TaxonomyDepthError(`parent skill ${input.parentId} does not exist`);
    }
    if (found.parent_id !== null) {
      throw new TaxonomyDepthError(
        'the taxonomy is two levels deep (ADR-009): a skill whose parent already has a parent ' +
          'would be a third level. Attach it to the grandparent, or promote the parent.',
      );
    }
  }

  const rows = await tx.execute<{
    id: string;
    org_id: string | null;
    parent_id: string | null;
    key: string;
    name: string;
    category: string | null;
  }>(sql`
    INSERT INTO skills (org_id, parent_id, key, name, category)
    VALUES (${input.orgId}::uuid, ${input.parentId ?? null}::uuid, ${input.key},
            ${input.name}, ${input.category ?? null})
    RETURNING id, org_id, parent_id, key, name, category
  `);
  const created = rows[0];
  if (created === undefined) {
    throw new Error('createSkill inserted no row');
  }
  return toSkillRow(created);
}

export interface MergeSkillsResult {
  readonly questionTagsRewritten: number;
  readonly roleRequirementsRewritten: number;
  readonly childrenReparented: number;
}

/**
 * Merges `sourceId` into `targetId`, rewriting every reference, then deletes the source.
 *
 * ADR-009 names taxonomy rot as the standing risk: `python`, `python3` and `Python` as three
 * skills splits a role's coverage three ways and makes the bank look thinner than it is. Merging
 * is therefore a first-class, audited operation rather than something done by hand in SQL.
 *
 * `ON CONFLICT DO NOTHING` on both rewrites matters: a question already tagged with both skills
 * would otherwise violate the composite primary key half way through. The row count returned is
 * what actually moved, not what was attempted.
 */
export async function mergeSkills(
  tx: DbTransaction,
  sourceId: string,
  targetId: string,
): Promise<MergeSkillsResult> {
  if (sourceId === targetId) {
    throw new TaxonomyDepthError('a skill cannot be merged into itself');
  }

  const tags = await tx.execute<{ moved: string }>(sql`
    WITH moved AS (
      INSERT INTO question_skills (question_id, skill_id, weight)
      SELECT question_id, ${targetId}::uuid, weight FROM question_skills
       WHERE skill_id = ${sourceId}::uuid
      ON CONFLICT DO NOTHING
      RETURNING 1
    ) SELECT count(*)::text AS moved FROM moved
  `);

  const roles = await tx.execute<{ moved: string }>(sql`
    WITH moved AS (
      INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty,
                                   max_difficulty, is_required)
      SELECT job_role_id, ${targetId}::uuid, weight, min_difficulty, max_difficulty, is_required
        FROM job_role_skills WHERE skill_id = ${sourceId}::uuid
      ON CONFLICT DO NOTHING
      RETURNING 1
    ) SELECT count(*)::text AS moved FROM moved
  `);

  const children = await tx.execute<{ moved: string }>(sql`
    WITH moved AS (
      UPDATE skills SET parent_id = ${targetId}::uuid
       WHERE parent_id = ${sourceId}::uuid
      RETURNING 1
    ) SELECT count(*)::text AS moved FROM moved
  `);

  await tx.execute(sql`DELETE FROM skills WHERE id = ${sourceId}::uuid`);

  return {
    questionTagsRewritten: Number.parseInt(tags[0]?.moved ?? '0', 10),
    roleRequirementsRewritten: Number.parseInt(roles[0]?.moved ?? '0', 10),
    childrenReparented: Number.parseInt(children[0]?.moved ?? '0', 10),
  };
}

// ---------------------------------------------------------------------------- coverage

export interface CoverageRow {
  readonly skillId: string;
  readonly skillKey: string;
  readonly skillName: string;
  readonly isRequired: boolean;
  readonly weight: number;
  readonly minDifficulty: number | null;
  readonly maxDifficulty: number | null;
  readonly inBand: number;
  readonly published: number;
  readonly byDifficulty: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/**
 * Counts published questions per required skill of a role, by difficulty.
 *
 * Three things this query gets deliberately right:
 *
 * 1. It counts **questions**, not question versions. A question with six published versions is
 *    one question a candidate can be asked, and counting versions would report a bank six times
 *    larger than it is.
 * 2. It counts only `status = 'published'` and `archived_at IS NULL`. A draft cannot be served.
 * 3. It `LEFT JOIN`s from the role's requirements, so a required skill with **zero** questions
 *    appears as a row of zeroes rather than vanishing. A gap that disappears from the report is
 *    the failure this endpoint exists to prevent.
 */
export async function getJobRoleCoverage(
  tx: DbTransaction,
  jobRoleId: string,
): Promise<CoverageRow[]> {
  const rows = await tx.execute<{
    skill_id: string;
    skill_key: string;
    skill_name: string;
    is_required: boolean;
    weight: string;
    min_difficulty: number | null;
    max_difficulty: number | null;
    in_band: string;
    published: string;
    d1: string;
    d2: string;
    d3: string;
    d4: string;
    d5: string;
  }>(sql`
    SELECT s.id                                             AS skill_id,
           s.key                                            AS skill_key,
           s.name                                           AS skill_name,
           jrs.is_required,
           jrs.weight::text                                 AS weight,
           jrs.min_difficulty,
           jrs.max_difficulty,
           count(DISTINCT q.id) FILTER (
             WHERE qv.difficulty BETWEEN coalesce(jrs.min_difficulty, 1)
                                     AND coalesce(jrs.max_difficulty, 5)
           )::text                                          AS in_band,
           count(DISTINCT q.id)::text                       AS published,
           count(DISTINCT q.id) FILTER (WHERE qv.difficulty = 1)::text AS d1,
           count(DISTINCT q.id) FILTER (WHERE qv.difficulty = 2)::text AS d2,
           count(DISTINCT q.id) FILTER (WHERE qv.difficulty = 3)::text AS d3,
           count(DISTINCT q.id) FILTER (WHERE qv.difficulty = 4)::text AS d4,
           count(DISTINCT q.id) FILTER (WHERE qv.difficulty = 5)::text AS d5
      FROM job_role_skills jrs
      JOIN skills s ON s.id = jrs.skill_id
      LEFT JOIN question_skills qs ON qs.skill_id = s.id
      LEFT JOIN questions q
             ON q.id = qs.question_id
            AND q.status = 'published'
            AND q.archived_at IS NULL
      LEFT JOIN question_versions qv ON qv.id = q.current_version_id
     WHERE jrs.job_role_id = ${jobRoleId}::uuid
     GROUP BY s.id, s.key, s.name, jrs.is_required, jrs.weight,
              jrs.min_difficulty, jrs.max_difficulty
     ORDER BY jrs.is_required DESC, jrs.weight DESC, s.key
  `);

  return rows.map((r) => ({
    skillId: r.skill_id,
    skillKey: r.skill_key,
    skillName: r.skill_name,
    isRequired: r.is_required,
    weight: Number.parseFloat(r.weight),
    minDifficulty: r.min_difficulty,
    maxDifficulty: r.max_difficulty,
    inBand: Number.parseInt(r.in_band, 10),
    published: Number.parseInt(r.published, 10),
    byDifficulty: {
      '1': Number.parseInt(r.d1, 10),
      '2': Number.parseInt(r.d2, 10),
      '3': Number.parseInt(r.d3, 10),
      '4': Number.parseInt(r.d4, 10),
      '5': Number.parseInt(r.d5, 10),
    },
  }));
}
