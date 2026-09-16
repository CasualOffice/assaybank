/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Job roles and what each one requires (ADR-009).
 *
 * Every function takes a transaction `withOrg` has scoped, and none filters on `org_id` by hand:
 * row-level security is what makes a read see one tenant.
 *
 * ## The one check RLS does not make
 *
 * A foreign key is checked by PostgreSQL **without** row-level security. `job_role_skills` and
 * `question_skills` are policed through their parent (the role, the question), not through the
 * skill, so an insert naming another organisation's skill id would satisfy both the policy and
 * the foreign key — and tag this tenant's role with a skill it cannot see, whose name and
 * category then appear in its coverage report. {@link invisibleSkillIds} is the check that
 * closes that: every skill id a caller supplies is resolved under RLS first, and an id this
 * tenant cannot read is refused exactly as if it did not exist.
 */

import { sql } from 'drizzle-orm';

import type { DbTransaction } from './client.js';

export interface JobRoleRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly family: string | null;
  readonly seniority: string | null;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

// A type alias, not an interface: `tx.execute<T>` requires `Record<string, unknown>`, which an
// interface does not satisfy because it could be merged with more members.
type JobRoleDbRow = {
  id: string;
  code: string;
  title: string;
  family: string | null;
  seniority: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
};

function toJobRoleRow(r: JobRoleDbRow): JobRoleRow {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    family: r.family,
    seniority: r.seniority,
    description: r.description,
    isActive: r.is_active,
    createdAt: new Date(r.created_at),
  };
}

const JOB_ROLE_COLUMNS = sql`id, code, title, family, seniority, description, is_active,
                             created_at::text AS created_at`;

export interface ListJobRolesFilter {
  readonly family?: string | undefined;
  readonly seniority?: string | undefined;
  readonly active?: boolean | undefined;
}

/** Ordered by code, which is unique per organisation, so the order is total. */
export async function listJobRoles(
  tx: DbTransaction,
  filter: ListJobRolesFilter,
): Promise<JobRoleRow[]> {
  const rows = await tx.execute<JobRoleDbRow>(sql`
    SELECT ${JOB_ROLE_COLUMNS}
      FROM job_roles
     WHERE (${filter.family ?? null}::text IS NULL OR family = ${filter.family ?? null})
       AND (${filter.seniority ?? null}::text IS NULL OR seniority = ${filter.seniority ?? null})
       AND (${filter.active ?? null}::boolean IS NULL OR is_active = ${filter.active ?? null})
     ORDER BY code
  `);
  return rows.map(toJobRoleRow);
}

export async function getJobRole(
  tx: DbTransaction,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<JobRoleRow | undefined> {
  const rows = await tx.execute<JobRoleDbRow>(sql`
    SELECT ${JOB_ROLE_COLUMNS} FROM job_roles WHERE id = ${id}::uuid
    ${options.forUpdate === true ? sql`FOR UPDATE` : sql``}
  `);
  const row = rows[0];
  return row === undefined ? undefined : toJobRoleRow(row);
}

export interface CreateJobRoleRecord {
  readonly orgId: string;
  readonly code: string;
  readonly title: string;
  readonly family?: string | undefined;
  readonly seniority?: string | undefined;
  readonly description?: string | undefined;
}

/**
 * Creates a role, or answers `undefined` when the code is already taken in this organisation.
 *
 * `ON CONFLICT DO NOTHING` rather than catching the unique violation: a caught error has already
 * aborted the transaction, and the audit row sharing it would be lost with the refusal.
 */
export async function createJobRole(
  tx: DbTransaction,
  input: CreateJobRoleRecord,
): Promise<JobRoleRow | undefined> {
  const rows = await tx.execute<JobRoleDbRow>(sql`
    INSERT INTO job_roles (org_id, code, title, family, seniority, description)
    VALUES (${input.orgId}::uuid, ${input.code}, ${input.title}, ${input.family ?? null},
            ${input.seniority ?? null}, ${input.description ?? null})
    ON CONFLICT (org_id, code) DO NOTHING
    RETURNING ${JOB_ROLE_COLUMNS}
  `);
  const row = rows[0];
  return row === undefined ? undefined : toJobRoleRow(row);
}

export interface JobRolePatch {
  readonly title?: string | undefined;
  readonly family?: string | undefined;
  readonly seniority?: string | undefined;
  readonly description?: string | undefined;
  readonly isActive?: boolean | undefined;
}

/** Applies only the fields named. `undefined` when the role is not visible to this tenant. */
export async function updateJobRole(
  tx: DbTransaction,
  id: string,
  patch: JobRolePatch,
): Promise<JobRoleRow | undefined> {
  const rows = await tx.execute<JobRoleDbRow>(sql`
    UPDATE job_roles
       SET title       = coalesce(${patch.title ?? null}, title),
           family      = coalesce(${patch.family ?? null}, family),
           seniority   = coalesce(${patch.seniority ?? null}, seniority),
           description = coalesce(${patch.description ?? null}, description),
           is_active   = coalesce(${patch.isActive ?? null}::boolean, is_active)
     WHERE id = ${id}::uuid
     RETURNING ${JOB_ROLE_COLUMNS}
  `);
  const row = rows[0];
  return row === undefined ? undefined : toJobRoleRow(row);
}

// ---------------------------------------------------------------------------- requirements

export interface JobRoleSkillRow {
  readonly skillId: string;
  readonly skillKey: string;
  readonly skillName: string;
  readonly weight: number;
  readonly minDifficulty: number | null;
  readonly maxDifficulty: number | null;
  readonly isRequired: boolean;
}

/** Required first, then heaviest, then by key — the same order the coverage report uses. */
export async function getJobRoleSkills(
  tx: DbTransaction,
  jobRoleId: string,
): Promise<JobRoleSkillRow[]> {
  const rows = await tx.execute<{
    skill_id: string;
    skill_key: string;
    skill_name: string;
    weight: string;
    min_difficulty: number | null;
    max_difficulty: number | null;
    is_required: boolean;
  }>(sql`
    SELECT s.id AS skill_id, s.key AS skill_key, s.name AS skill_name, jrs.weight::text AS weight,
           jrs.min_difficulty, jrs.max_difficulty, jrs.is_required
      FROM job_role_skills jrs
      JOIN skills s ON s.id = jrs.skill_id
     WHERE jrs.job_role_id = ${jobRoleId}::uuid
     ORDER BY jrs.is_required DESC, jrs.weight DESC, s.key
  `);
  return rows.map((r) => ({
    skillId: r.skill_id,
    skillKey: r.skill_key,
    skillName: r.skill_name,
    weight: Number.parseFloat(r.weight),
    minDifficulty: r.min_difficulty,
    maxDifficulty: r.max_difficulty,
    isRequired: r.is_required,
  }));
}

export interface JobRoleSkillInputRow {
  readonly skillId: string;
  readonly weight: number;
  readonly minDifficulty?: number | undefined;
  readonly maxDifficulty?: number | undefined;
  readonly isRequired: boolean;
}

/**
 * Replaces the role's whole requirement set.
 *
 * The caller must have passed the skill ids through {@link invisibleSkillIds} first; see the
 * module comment for why the foreign key alone is not enough.
 */
export async function setJobRoleSkills(
  tx: DbTransaction,
  jobRoleId: string,
  skills: readonly JobRoleSkillInputRow[],
): Promise<void> {
  await tx.execute(sql`DELETE FROM job_role_skills WHERE job_role_id = ${jobRoleId}::uuid`);
  for (const s of skills) {
    await tx.execute(sql`
      INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty, max_difficulty,
                                   is_required)
      VALUES (${jobRoleId}::uuid, ${s.skillId}::uuid, ${s.weight.toFixed(2)}::numeric,
              ${s.minDifficulty ?? null}::smallint, ${s.maxDifficulty ?? null}::smallint,
              ${s.isRequired})
    `);
  }
}

/**
 * The ids in `skillIds` this tenant cannot read — another organisation's, or no skill at all.
 *
 * Global skills (`org_id IS NULL`) are readable by every tenant and so are never returned.
 * Sorted, so an error naming them is stable.
 */
export async function invisibleSkillIds(
  tx: DbTransaction,
  skillIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(skillIds)].sort();
  if (unique.length === 0) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM skills
     WHERE id IN (${sql.join(
       unique.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `);
  const visible = new Set(rows.map((r) => r.id));
  return unique.filter((id) => !visible.has(id));
}
