/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 7 of docs/hiring_platform_schema.sql — code execution.
 *
 * Every run is recorded with the runtime identity that produced it: `language`,
 * `language_version` and `runtime_image`. That triple is what makes a re-grade a year
 * later reproduce the same result rather than a plausible one, and it is why none of the
 * three is nullable by accident.
 *
 * `is_trial_run` separates a candidate pressing "Run" from a graded submission. ADR-008
 * puts the two on separate queues by latency class, so a batch backlog can never delay a
 * candidate waiting on sample output.
 *
 * Nothing in this file holds an expectation. `submission_results.actual_stdout` is what
 * the code produced; the value it is compared against lives in `test_cases` and is
 * compared by `packages/grading`, which is pure. The sandbox never sees either
 * (ADR-002).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { attemptQuestions } from './candidates-attempts.js';
import { tstz } from './columns.js';
import { interviewSessions } from './interviews.js';
import { testCases } from './question-bank.js';
import { orgRef } from './tenancy-rbac.js';

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    /** Set for an assessment run. Null for a live-interview run. */
    attemptQuestionId: uuid('attempt_question_id').references(
      (): AnyPgColumn => attemptQuestions.id,
      { onDelete: 'cascade' },
    ),
    /** Set for a live-interview run. Null for an assessment run. */
    interviewSessionId: uuid('interview_session_id').references(
      (): AnyPgColumn => interviewSessions.id,
    ),
    language: text('language').notNull(),
    /** `3.12.0`. Reproducibility: a score must be explainable months later. */
    languageVersion: text('language_version').notNull(),
    /** Piston package id or container digest. The other half of reproducibility. */
    runtimeImage: text('runtime_image'),
    /** Untrusted input. Treated as hostile end to end (docs/17 §7). */
    sourceCode: text('source_code').notNull(),
    /** The candidate pressed "Run", not "Submit". Different queue, different latency class. */
    isTrialRun: boolean('is_trial_run').notNull().default(false),
    /** `queued` | `running` | `done` | `error` | `timeout`. */
    status: text('status').notNull().default('queued'),
    compileStderr: text('compile_stderr'),
    totalPassed: integer('total_passed'),
    totalCases: integer('total_cases'),
    score: numeric('score', { precision: 6, scale: 2 }),
    runtimeMs: integer('runtime_ms'),
    memoryKb: integer('memory_kb'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('submissions_attempt_question_id_created_at_idx').on(
      t.attemptQuestionId,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * One row per test case per submission.
 *
 * `actual_stdout` and `stderr` are truncated before storing — these get large, and an
 * untruncated failing case from a program printing in a loop is an unbounded write on
 * the hot path. Truncation happens in the worker, not here.
 */
export const submissionResults = pgTable(
  'submission_results',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    submissionId: uuid('submission_id')
      .notNull()
      .references((): AnyPgColumn => submissions.id, { onDelete: 'cascade' }),
    /** Nullable: a compile failure produces results attached to no particular case. */
    testCaseId: uuid('test_case_id').references((): AnyPgColumn => testCases.id),
    passed: boolean('passed').notNull(),
    actualStdout: text('actual_stdout'),
    stderr: text('stderr'),
    exitCode: integer('exit_code'),
    runtimeMs: integer('runtime_ms'),
    memoryKb: integer('memory_kb'),
  },
  (t) => [index('submission_results_submission_id_idx').on(t.submissionId)],
);
