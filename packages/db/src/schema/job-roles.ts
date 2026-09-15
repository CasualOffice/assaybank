/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 3 of docs/hiring_platform_schema.sql — job roles and openings.
 *
 * A job role is a position being hired for. It is not a `user_roles` row, which is a
 * permission set inside the tool. The two are deliberately separate tables with
 * deliberately different names.
 *
 * `job_role_skills` carries the weights that drive automatic assessment generation and
 * the per-skill roll-up on a scorecard. The difficulty bounds are `CHECK`ed in the
 * database rather than in application code, because the importer and the migrations
 * write this table too and neither of them runs a validation function (docs/17 §4).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { tstz } from './columns.js';
import { skills } from './skills.js';
import { orgRef } from './tenancy-rbac.js';

export const jobRoles = pgTable(
  'job_roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    /** `BE-SDE1`, `DATA-ANALYST`. Unique within the organisation. */
    code: text('code').notNull(),
    title: text('title').notNull(),
    /** `engineering` | `data` | `devops`. */
    family: text('family'),
    /** `intern` | `junior` | `mid` | `senior` | `staff`. */
    seniority: text('seniority'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('job_roles_org_id_code_key').on(t.orgId, t.code)],
);

/** What a role needs, and how much each skill matters. */
export const jobRoleSkills = pgTable(
  'job_role_skills',
  {
    jobRoleId: uuid('job_role_id')
      .notNull()
      .references((): AnyPgColumn => jobRoles.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references((): AnyPgColumn => skills.id, { onDelete: 'cascade' }),
    /** `numeric`, never a float: a weight participates in a score (docs/17 §4). */
    weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1.0'),
    minDifficulty: smallint('min_difficulty'),
    maxDifficulty: smallint('max_difficulty'),
    isRequired: boolean('is_required').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'job_role_skills_pkey', columns: [t.jobRoleId, t.skillId] }),
    check('job_role_skills_weight_check', sql`weight >= 0`),
    check('job_role_skills_min_difficulty_check', sql`min_difficulty BETWEEN 1 AND 5`),
    check('job_role_skills_max_difficulty_check', sql`max_difficulty BETWEEN 1 AND 5`),
    index('job_role_skills_skill_id_idx').on(t.skillId),
  ],
);

export const jobOpenings = pgTable('job_openings', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgId: orgRef(),
  jobRoleId: uuid('job_role_id')
    .notNull()
    .references((): AnyPgColumn => jobRoles.id),
  title: text('title').notNull(),
  location: text('location'),
  headcount: integer('headcount').notNull().default(1),
  /** `open` | `paused` | `closed`. */
  status: text('status').notNull().default('open'),
  openedAt: tstz('opened_at').notNull().defaultNow(),
  closedAt: tstz('closed_at'),
});
