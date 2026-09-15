/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 5 of docs/hiring_platform_schema.sql — assessments, the test templates.
 *
 * A section either pins specific questions (`section_questions`) or draws them from a
 * pool described by a rule (`section_rules`). The certification-style randomisation
 * comes entirely from the rules.
 *
 * These tables describe how a question set is *chosen*. They are not what a candidate
 * was served: ADR-004 materialises the resolved set into `attempt_questions` once, in the
 * attempt-start transaction, and it is never re-rolled. Editing an assessment mid-window
 * therefore cannot change what an in-flight candidate sees, and a re-grade reads the
 * materialised set rather than re-running the draw.
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
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { tstz } from './columns.js';
import { jobRoles } from './job-roles.js';
import { questionKind, questionStatus, questionVersions, questions } from './question-bank.js';
import { orgRef, users } from './tenancy-rbac.js';

export const assessments = pgTable('assessments', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgId: orgRef(),
  jobRoleId: uuid('job_role_id').references((): AnyPgColumn => jobRoles.id),
  name: text('name').notNull(),
  description: text('description'),
  /**
   * The budget `deadline_at` is computed from at attempt start. The server owns that
   * arithmetic and the client clock is display only (ADR-006).
   */
  durationSeconds: integer('duration_seconds').notNull(),
  passScorePct: numeric('pass_score_pct', { precision: 5, scale: 2 }),
  shuffleSections: boolean('shuffle_sections').notNull().default(false),
  allowBackNav: boolean('allow_back_nav').notNull().default(true),
  /**
   * `none` | `basic` | `strict`. Selects which advisory signals are captured. No value
   * here causes a rejection, a void or a score change — ADR-007 and ADR-017 put every
   * integrity signal in front of a human with its evidence, and nowhere else.
   */
  proctoringProfile: text('proctoring_profile').notNull().default('none'),
  status: questionStatus('status').notNull().default('draft'),
  versionNo: integer('version_no').notNull().default(1),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const assessmentSections = pgTable(
  'assessment_sections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references((): AnyPgColumn => assessments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** `Aptitude MCQ`, `DSA coding`. */
    name: text('name').notNull(),
    /** Optional homogeneity constraint on what the section may contain. */
    kind: questionKind('kind'),
    /** Null means the section shares the assessment-wide timer. */
    durationSeconds: integer('duration_seconds'),
    shuffleQuestions: boolean('shuffle_questions').notNull().default(true),
    shuffleOptions: boolean('shuffle_options').notNull().default(true),
  },
  (t) => [unique('assessment_sections_assessment_id_ordinal_key').on(t.assessmentId, t.ordinal)],
);

/** Fixed picks. `pin_version_id` null means "resolve to the current version at draw time". */
export const sectionQuestions = pgTable(
  'section_questions',
  {
    sectionId: uuid('section_id')
      .notNull()
      .references((): AnyPgColumn => assessmentSections.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references((): AnyPgColumn => questions.id),
    pinVersionId: uuid('pin_version_id').references((): AnyPgColumn => questionVersions.id),
    ordinal: integer('ordinal').notNull(),
    scoreOverride: numeric('score_override', { precision: 6, scale: 2 }),
  },
  (t) => [primaryKey({ name: 'section_questions_pkey', columns: [t.sectionId, t.questionId] })],
);

/**
 * A random draw: "5 questions, skill = python, difficulty 2-3, not seen in 90 days".
 *
 * The rule is resolved once, at attempt start, into `attempt_questions` (ADR-004). It is
 * never consulted again for that attempt, so changing a rule cannot retroactively change
 * what was asked.
 */
export const sectionRules = pgTable(
  'section_rules',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sectionId: uuid('section_id')
      .notNull()
      .references((): AnyPgColumn => assessmentSections.id, { onDelete: 'cascade' }),
    pickCount: integer('pick_count').notNull(),
    skillIds: uuid('skill_ids').array().notNull().default([]),
    kinds: questionKind('kinds').array().notNull().default([]),
    minDifficulty: smallint('min_difficulty').notNull().default(1),
    maxDifficulty: smallint('max_difficulty').notNull().default(5),
    /** Exposure control: exclude anything this candidate has seen inside the window. */
    excludeSeenDays: integer('exclude_seen_days').notNull().default(0),
    scorePerQuestion: numeric('score_per_question', { precision: 6, scale: 2 }),
  },
  () => [check('section_rules_pick_count_check', sql`pick_count > 0`)],
);
