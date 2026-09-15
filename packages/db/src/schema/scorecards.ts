/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 9 of docs/hiring_platform_schema.sql — scorecards, structured human judgement.
 *
 * A scorecard attaches to exactly one of an interview session or an attempt, never both
 * and never neither, which is a `CHECK` because a scorecard attached to nothing is a
 * review nobody can find and a scorecard attached to two things is a review that counts
 * twice.
 *
 * `anchor_md` — what a 1 versus a 4 actually looks like — is the part that makes the
 * numbers comparable between reviewers. Without anchors a five-point scale is five
 * different scales.
 *
 * This is the human side of scoring. ADR-011 keeps every model out of the scoring and
 * decision path, so nothing writes these rows except a person.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { attempts } from './candidates-attempts.js';
import { tstz } from './columns.js';
import { interviewSessions } from './interviews.js';
import { jobRoles } from './job-roles.js';
import { skills } from './skills.js';
import { orgRef, users } from './tenancy-rbac.js';

export const scorecardTemplates = pgTable('scorecard_templates', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgId: orgRef(),
  jobRoleId: uuid('job_role_id').references((): AnyPgColumn => jobRoles.id),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const scorecardCriteria = pgTable('scorecard_criteria', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  templateId: uuid('template_id')
    .notNull()
    .references((): AnyPgColumn => scorecardTemplates.id, { onDelete: 'cascade' }),
  /** Ties the judgement back to the taxonomy so a role's coverage can be reported. */
  skillId: uuid('skill_id').references((): AnyPgColumn => skills.id),
  ordinal: integer('ordinal').notNull(),
  label: text('label').notNull(),
  /** What a 1 versus a 4 actually looks like. This is what makes reviewers comparable. */
  anchorMd: text('anchor_md'),
  weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1.0'),
  scaleMax: smallint('scale_max').notNull().default(4),
});

export const scorecards = pgTable(
  'scorecards',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    templateId: uuid('template_id')
      .notNull()
      .references((): AnyPgColumn => scorecardTemplates.id),
    sessionId: uuid('session_id').references((): AnyPgColumn => interviewSessions.id, {
      onDelete: 'cascade',
    }),
    attemptId: uuid('attempt_id').references((): AnyPgColumn => attempts.id, {
      onDelete: 'cascade',
    }),
    /** A person. Never null, never a service account: someone owns this judgement. */
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references((): AnyPgColumn => users.id),
    /** `strong_no` | `no` | `yes` | `strong_yes`. */
    overall: text('overall'),
    notesMd: text('notes_md'),
    submittedAt: tstz('submitted_at'),
  },
  () => [check('scorecards_check', sql`num_nonnulls(session_id, attempt_id) = 1`)],
);

export const scorecardRatings = pgTable(
  'scorecard_ratings',
  {
    scorecardId: uuid('scorecard_id')
      .notNull()
      .references((): AnyPgColumn => scorecards.id, { onDelete: 'cascade' }),
    criterionId: uuid('criterion_id')
      .notNull()
      .references((): AnyPgColumn => scorecardCriteria.id),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
  },
  (t) => [primaryKey({ name: 'scorecard_ratings_pkey', columns: [t.scorecardId, t.criterionId] })],
);
