/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 4 of docs/hiring_platform_schema.sql — the question bank.
 *
 * `questions` is stable identity; `question_versions` is immutable content. ADR-003: a
 * published version is never mutated. Authoring a change inserts a new version and moves
 * `questions.current_version_id`; the attempts that were served the old version keep
 * pointing at exactly the bytes their candidates saw, which is what makes a score
 * explainable a year later and a dispute resolvable at all.
 *
 * The immutability itself is enforced by a database trigger in migration 0001 rather
 * than by application code, because the API is not the only writer — the bank importer
 * and future migrations are too, and neither runs the API's validation.
 *
 * Three of these tables hold content a candidate must never see: `mcq_options.is_correct`
 * and `score_delta`, `coding_specs.solution_code` and `checker_code`, and
 * `test_cases.expected_stdout` for any row with `is_sample = false` (FR-12). Nothing in
 * this file can enforce that — it is enforced by the typed serialisers in the API and by
 * the standing leak suite — but the columns are marked here so that a serialiser author
 * has no excuse.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
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
import { orgRef, users } from './tenancy-rbac.js';

/** What kind of thing a question is, which determines how it is answered and graded. */
export const questionKind = pgEnum('question_kind', [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_answer',
  'coding',
  'sql',
  'subjective',
  'system_design',
]);

/** The authoring lifecycle. `published` is the point after which content is frozen. */
export const questionStatus = pgEnum('question_status', [
  'draft',
  'review',
  'published',
  'retired',
]);

export const questions = pgTable(
  'questions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    kind: questionKind('kind').notNull(),
    status: questionStatus('status').notNull().default('draft'),
    /**
     * The version served when a section does not pin one. Nullable because a question
     * exists for the instant between its own INSERT and its first version's.
     */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => questionVersions.id),
    /** `humaneval/42`, `lbpp/17` for imported content. */
    externalRef: text('external_ref'),
    /** `MIT`, `Apache-2.0`, `CC-BY-4.0`, `proprietary` — ADR-001 applies to content too. */
    sourceLicense: text('source_license'),
    authorId: uuid('author_id').references((): AnyPgColumn => users.id),
    /** Times served. A question seen too often stops measuring anything. */
    exposureCount: integer('exposure_count').notNull().default(0),
    archivedAt: tstz('archived_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('questions_org_id_kind_status_idx')
      .on(t.orgId, t.kind, t.status)
      .where(sql`archived_at IS NULL`),
  ],
);

/**
 * Immutable content (ADR-003). `locale` records the language the version was *authored*
 * in and is never used to represent a translation — a translation is its own row in a
 * future `question_version_translations` table, with its own statistics, because a
 * translated item is a different item (ADR-018).
 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    questionId: uuid('question_id')
      .notNull()
      .references((): AnyPgColumn => questions.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    locale: text('locale').notNull().default('en'),
    /** Markdown, rendered client-side. Untrusted input: sanitise on render (docs/17 §7). */
    promptMd: text('prompt_md').notNull(),
    explanationMd: text('explanation_md'),
    difficulty: smallint('difficulty').notNull(),
    estSeconds: integer('est_seconds').notNull().default(120),
    maxScore: numeric('max_score', { precision: 6, scale: 2 }).notNull().default('1.0'),
    /** Negative marking. Zero unless the assessment deliberately uses it. */
    negativeScore: numeric('negative_score', { precision: 6, scale: 2 }).notNull().default('0.0'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Non-null is the freeze line. After this instant the row is read-only (ADR-003). */
    publishedAt: tstz('published_at'),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('question_versions_question_id_version_no_locale_key').on(
      t.questionId,
      t.versionNo,
      t.locale,
    ),
    check('question_versions_difficulty_check', sql`difficulty BETWEEN 1 AND 5`),
    index('question_versions_question_id_version_no_idx').on(t.questionId, t.versionNo.desc()),
    // Fuzzy search over prompts. pg_trgm, declared in migration 0001 alongside pgcrypto
    // and citext so the extension set is versioned with the tables that need it.
    index('question_versions_prompt_md_trgm_idx').using('gin', sql`${t.promptMd} gin_trgm_ops`),
  ],
);

/** What a question measures, and how much of it. */
export const questionSkills = pgTable(
  'question_skills',
  {
    questionId: uuid('question_id')
      .notNull()
      .references((): AnyPgColumn => questions.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references((): AnyPgColumn => skills.id, { onDelete: 'cascade' }),
    weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1.0'),
  },
  (t) => [
    primaryKey({ name: 'question_skills_pkey', columns: [t.questionId, t.skillId] }),
    index('question_skills_skill_id_idx').on(t.skillId),
  ],
);

/**
 * MCQ options.
 *
 * `is_correct`, `score_delta` and `rationale_md` are answer-key material. A
 * candidate-facing serialiser must be structurally incapable of carrying them — not a
 * staff serialiser with a boolean flag, which is the anti-pattern docs/17 §12 names by
 * its failure mode (FR-12).
 */
export const mcqOptions = pgTable(
  'mcq_options',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    questionVersionId: uuid('question_version_id')
      .notNull()
      .references((): AnyPgColumn => questionVersions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    bodyMd: text('body_md').notNull(),
    /** ANSWER KEY. Never in a candidate-scoped response. */
    isCorrect: boolean('is_correct').notNull().default(false),
    /** ANSWER KEY. Overrides the default partial credit. */
    scoreDelta: numeric('score_delta', { precision: 6, scale: 2 }),
    /** ANSWER KEY until the attempt is over and review is permitted. */
    rationaleMd: text('rationale_md'),
  },
  (t) => [unique('mcq_options_question_version_id_ordinal_key').on(t.questionVersionId, t.ordinal)],
);

/**
 * The coding and SQL execution spec.
 *
 * `solution_code` and `checker_code` never leave the server, and ADR-002 keeps
 * expectations out of the sandbox entirely: `packages/exec-adapter` receives code and
 * inputs and never learns a question id, so there is nothing for an escaped process to
 * read.
 */
export const codingSpecs = pgTable('coding_specs', {
  questionVersionId: uuid('question_version_id')
    .primaryKey()
    .references((): AnyPgColumn => questionVersions.id, { onDelete: 'cascade' }),
  allowedLanguages: text('allowed_languages').array().notNull(),
  starterCode: jsonb('starter_code').$type<Record<string, string>>().notNull().default({}),
  /** REFERENCE SOLUTIONS. Never sent to a client, staff or candidate. */
  solutionCode: jsonb('solution_code').$type<Record<string, string>>().notNull().default({}),
  timeLimitMs: integer('time_limit_ms').notNull().default(5000),
  memoryLimitKb: integer('memory_limit_kb').notNull().default(262144),
  /** `test_cases` | `unit_tests` | `custom_checker`. */
  gradingMode: text('grading_mode').notNull().default('test_cases'),
  /** REFERENCE. A custom checker reveals the shape of the expected answer. */
  checkerCode: text('checker_code'),
  /** For `kind = 'sql'`: schema plus seed data for the fixture database. */
  fixtureSql: text('fixture_sql'),
});

/**
 * Test cases.
 *
 * `is_sample = true` is the only row a candidate may see, and only its `stdin` and
 * `expected_stdout`. Every other row is hidden test-case content, which
 * docs/14-threat-model.md records as a real target reachable through a leaked error
 * message — hence "never leak an upstream error verbatim" in docs/17 §3.
 */
export const testCases = pgTable(
  'test_cases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    questionVersionId: uuid('question_version_id')
      .notNull()
      .references((): AnyPgColumn => questionVersions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label'),
    stdin: text('stdin').notNull().default(''),
    /** HIDDEN unless `is_sample`. This is the expectation ADR-002 keeps out of the sandbox. */
    expectedStdout: text('expected_stdout'),
    args: text('args').array(),
    /** The one flag that makes a case visible to a candidate. */
    isSample: boolean('is_sample').notNull().default(false),
    weight: numeric('weight', { precision: 6, scale: 2 }).notNull().default('1.0'),
  },
  (t) => [unique('test_cases_question_version_id_ordinal_key').on(t.questionVersionId, t.ordinal)],
);

/** Auto-graded short answers. Every row is answer-key material. */
export const shortAnswerKeys = pgTable('short_answer_keys', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  questionVersionId: uuid('question_version_id')
    .notNull()
    .references((): AnyPgColumn => questionVersions.id, { onDelete: 'cascade' }),
  /** `exact` | `ci` | `regex` | `numeric_tolerance`. */
  matchType: text('match_type').notNull(),
  /** ANSWER KEY. */
  pattern: text('pattern').notNull(),
  tolerance: numeric('tolerance'),
  score: numeric('score', { precision: 6, scale: 2 }).notNull().default('1.0'),
});

/**
 * Psychometrics, recomputed nightly by the worker. Lets a bad question be retired on
 * evidence instead of guessed at forever (PRD FR-5).
 *
 * `p_value` between 0.2 and 0.8 is the useful band; `discrimination` above 0.2 is the
 * floor. Neither number is ever used to score a candidate — they describe the item, not
 * the person, and nothing in the scoring path reads this table.
 */
export const questionStats = pgTable('question_stats', {
  questionVersionId: uuid('question_version_id')
    .primaryKey()
    .references((): AnyPgColumn => questionVersions.id, { onDelete: 'cascade' }),
  nAttempts: integer('n_attempts').notNull().default(0),
  pValue: numeric('p_value', { precision: 5, scale: 4 }),
  discrimination: numeric('discrimination', { precision: 5, scale: 4 }),
  meanSeconds: numeric('mean_seconds', { precision: 8, scale: 2 }),
  computedAt: tstz('computed_at'),
});
