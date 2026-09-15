/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 6 of docs/hiring_platform_schema.sql — candidates, invitations and attempts.
 *
 * Three invariants live in this file and are worth reading before changing anything in
 * it:
 *
 * 1. **`attempts.deadline_at` is server-computed** at start, from
 *    `assessments.duration_seconds` and the server's clock, and is never extended by
 *    client input (ADR-006). The candidate's countdown is a rendering of this column,
 *    not a source of it.
 * 2. **`attempt_questions` is the served set** — written once, in the attempt-start
 *    transaction, never re-rolled (ADR-004). Without it a re-grade is guesswork, a
 *    dispute is unresolvable and exposure cannot be measured.
 * 3. **`attempts.integrity_flag` is advisory.** It records what a human concluded or
 *    what a signal suggested. No code path may read it and reject, void or down-score
 *    (ADR-007, ADR-017).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { assessmentSections, assessments } from './assessments.js';
import { citext, tstz } from './columns.js';
import { jobOpenings } from './job-roles.js';
import { questionVersions } from './question-bank.js';
import { orgRef, users } from './tenancy-rbac.js';
import { submissions } from './execution.js';

/** A person being assessed. Candidates hold attempt tokens; they have no account. */
export const candidates = pgTable(
  'candidates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    email: citext('email').notNull(),
    fullName: text('full_name'),
    phone: text('phone'),
    resumeUrl: text('resume_url'),
    /** `campus` | `referral` | `inbound`. */
    source: text('source'),
    /** Proctoring and data-processing consent. Null means not given (docs/11). */
    consentAt: tstz('consent_at'),
    /** The GDPR retention clock. The worker's sweep erases on it (docs/11 §4.1). */
    eraseAfter: tstz('erase_after'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('candidates_org_id_email_key').on(t.orgId, t.email)],
);

export const applications = pgTable(
  'applications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references((): AnyPgColumn => candidates.id, { onDelete: 'cascade' }),
    jobOpeningId: uuid('job_opening_id')
      .notNull()
      .references((): AnyPgColumn => jobOpenings.id),
    /** `applied` | `screening` | `interview` | `offer` | `rejected`. */
    stage: text('stage').notNull().default('applied'),
    stageChangedAt: tstz('stage_changed_at').notNull().defaultNow(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('applications_candidate_id_job_opening_id_key').on(t.candidateId, t.jobOpeningId)],
);

/**
 * An invitation to sit an assessment.
 *
 * `token_hash` is the hash, never the plaintext: docs/17 §7 requires tokens to be
 * high-entropy, hashed at rest, single-purpose and expiring, with the plaintext returned
 * exactly once. `max_attempts` bounds how many sittings the token grants.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    applicationId: uuid('application_id').references((): AnyPgColumn => applications.id, {
      onDelete: 'cascade',
    }),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references((): AnyPgColumn => assessments.id),
    /** Store the hash, mail the plaintext. Globally unique so a lookup needs no org. */
    tokenHash: text('token_hash').notNull().unique('invitations_token_hash_key'),
    opensAt: tstz('opens_at'),
    expiresAt: tstz('expires_at').notNull(),
    maxAttempts: integer('max_attempts').notNull().default(1),
    sentAt: tstz('sent_at'),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // The expiry sweep only cares about invitations that were actually sent.
    index('invitations_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`sent_at IS NOT NULL`),
  ],
);

/**
 * The attempt lifecycle.
 *
 * `auto_graded` precedes `finalised`: an attempt reaches `finalised` only when every
 * `answers.final_score` is non-null, checked in the same transaction that sets the
 * status (docs/17 §4). `under_review` is where an attempt waits for a human — including
 * when grading exhausted its retries, because no infrastructure failure scores anyone
 * zero (docs/17 §0).
 */
export const attemptStatus = pgEnum('attempt_status', [
  'created',
  'in_progress',
  'submitted',
  'expired',
  'auto_graded',
  'under_review',
  'finalised',
  'voided',
]);

export const attempts = pgTable(
  'attempts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    invitationId: uuid('invitation_id').references((): AnyPgColumn => invitations.id),
    candidateId: uuid('candidate_id')
      .notNull()
      .references((): AnyPgColumn => candidates.id),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references((): AnyPgColumn => assessments.id),
    /** The `assessments.version_no` in force at start. Pinned, like the question set. */
    assessmentVersion: integer('assessment_version').notNull(),
    status: attemptStatus('status').notNull().default('created'),
    startedAt: tstz('started_at'),
    /** Server-computed at start. The client clock is display only (ADR-006). */
    deadlineAt: tstz('deadline_at'),
    submittedAt: tstz('submitted_at'),
    rawScore: numeric('raw_score', { precision: 8, scale: 2 }),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }),
    scorePct: numeric('score_pct', { precision: 5, scale: 2 }),
    passed: boolean('passed'),
    /**
     * `clean` | `suspicious` | `violation`. ADVISORY ONLY. Nothing reads this column to
     * decide an outcome; it exists so a human reviewing the attempt sees the summary of
     * what was observed, with the evidence attached (ADR-007).
     */
    integrityFlag: text('integrity_flag'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('attempts_org_id_status_idx').on(t.orgId, t.status),
    index('attempts_candidate_id_created_at_idx').on(t.candidateId, t.createdAt.desc()),
  ],
);

/**
 * The exact question set this candidate was served, in order, with the shuffle actually
 * shown. Materialised at attempt start and never re-rolled (ADR-004).
 */
export const attemptQuestions = pgTable(
  'attempt_questions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    attemptId: uuid('attempt_id')
      .notNull()
      .references((): AnyPgColumn => attempts.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references((): AnyPgColumn => assessmentSections.id),
    /** The version, not the question: the bytes the candidate saw (ADR-003). */
    questionVersionId: uuid('question_version_id')
      .notNull()
      .references((): AnyPgColumn => questionVersions.id),
    ordinal: integer('ordinal').notNull(),
    /** The option order actually rendered, so a re-grade reproduces the screen exactly. */
    optionOrder: integer('option_order').array(),
    maxScore: numeric('max_score', { precision: 6, scale: 2 }).notNull(),
  },
  (t) => [
    unique('attempt_questions_attempt_id_ordinal_key').on(t.attemptId, t.ordinal),
    // Exposure counting reads this the other way round.
    index('attempt_questions_question_version_id_idx').on(t.questionVersionId),
  ],
);

/**
 * One answer per served question — enforced by the unique constraint on
 * `attempt_question_id` rather than by the application, because the autosave path
 * retries and at-least-once delivery makes a duplicate insert normal rather than
 * exceptional (docs/17 §6).
 */
export const answers = pgTable('answers', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  attemptQuestionId: uuid('attempt_question_id')
    .notNull()
    .unique('answers_attempt_question_id_key')
    .references((): AnyPgColumn => attemptQuestions.id, { onDelete: 'cascade' }),
  /** MCQ selections. */
  selectedOptionIds: uuid('selected_option_ids').array(),
  /** Short answer and subjective. */
  textAnswer: text('text_answer'),
  /** Coding: the submission the candidate chose to be graded on. */
  finalSubmissionId: uuid('final_submission_id').references((): AnyPgColumn => submissions.id),
  secondsSpent: integer('seconds_spent').notNull().default(0),
  autoScore: numeric('auto_score', { precision: 6, scale: 2 }),
  manualScore: numeric('manual_score', { precision: 6, scale: 2 }),
  /**
   * The score that counts. An attempt may only reach `finalised` when this is non-null
   * for every one of its answers, checked in the finalisation transaction.
   */
  finalScore: numeric('final_score', { precision: 6, scale: 2 }),
  gradedBy: uuid('graded_by').references((): AnyPgColumn => users.id),
  gradedAt: tstz('graded_at'),
  answeredAt: tstz('answered_at').notNull().defaultNow(),
});
