/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The branded identifier types, and the schemas that mint them.
 *
 * docs/17 §1: "This domain has a dozen UUID-shaped identifiers and passing an
 * `attempt_id` where an `attempt_question_id` belongs is both easy and catastrophic."
 * A brand makes that a compile error instead of a support ticket.
 *
 * A brand is a type-level construct with no runtime representation: the parsed value is
 * the same string it always was, so a branded id serialises, logs and reaches the
 * database exactly like the UUID it is. The only way to obtain one is to parse — there
 * is no cast helper here on purpose, because a cast helper is a hole in the boundary
 * that docs/17 §1 ("parse, don't validate") draws.
 */

import './openapi-extension.js';

import type { z } from 'zod';

import { UuidSchema } from './primitives.js';

/**
 * Mints one identifier schema. `.describe()` clones, so every identifier below is a
 * distinct schema object carrying its own documentation, rather than sixteen aliases of
 * one shared instance.
 */
function identifier<TBrand extends string>(component: TBrand, description: string) {
  return UuidSchema.describe(description).openapi(component).brand<TBrand>();
}

/** The owning organisation. Every tenant row carries one (ADR-010). */
export const OrgIdSchema = identifier<'OrgId'>('OrgId', 'Identifier of the owning organisation.');
/** The owning organisation. Every tenant row carries one (ADR-010). */
export type OrgId = z.infer<typeof OrgIdSchema>;

/** A staff user: recruiter, interviewer or administrator. */
export const UserIdSchema = identifier<'UserId'>('UserId', 'Identifier of a staff user.');
/** A staff user: recruiter, interviewer or administrator. */
export type UserId = z.infer<typeof UserIdSchema>;

/** A person being assessed. Candidates have no account (docs/03 §1). */
export const CandidateIdSchema = identifier<'CandidateId'>(
  'CandidateId',
  'Identifier of a candidate.',
);
/** A person being assessed. Candidates have no account (docs/03 §1). */
export type CandidateId = z.infer<typeof CandidateIdSchema>;

/** A question in the bank, independent of any of its versions. */
export const QuestionIdSchema = identifier<'QuestionId'>(
  'QuestionId',
  'Identifier of a bank question.',
);
/** A question in the bank, independent of any of its versions. */
export type QuestionId = z.infer<typeof QuestionIdSchema>;

/** One immutable-once-published version of a question (ADR-003). */
export const QuestionVersionIdSchema = identifier<'QuestionVersionId'>(
  'QuestionVersionId',
  'Identifier of one version of a question. Frozen once published (ADR-003).',
);
/** One immutable-once-published version of a question (ADR-003). */
export type QuestionVersionId = z.infer<typeof QuestionVersionIdSchema>;

/** An assessment: the thing a candidate is invited to sit. */
export const AssessmentIdSchema = identifier<'AssessmentId'>(
  'AssessmentId',
  'Identifier of an assessment.',
);
/** An assessment: the thing a candidate is invited to sit. */
export type AssessmentId = z.infer<typeof AssessmentIdSchema>;

/** A section within an assessment. */
export const SectionIdSchema = identifier<'SectionId'>(
  'SectionId',
  'Identifier of an assessment section.',
);
/** A section within an assessment. */
export type SectionId = z.infer<typeof SectionIdSchema>;

/** One candidate's sitting of one assessment. */
export const AttemptIdSchema = identifier<'AttemptId'>('AttemptId', 'Identifier of an attempt.');
/** One candidate's sitting of one assessment. */
export type AttemptId = z.infer<typeof AttemptIdSchema>;

/**
 * One question as served to one attempt — the materialised row written once at attempt
 * start and never re-rolled (ADR-004).
 */
export const AttemptQuestionIdSchema = identifier<'AttemptQuestionId'>(
  'AttemptQuestionId',
  'Identifier of a question as served to one attempt (ADR-004).',
);
/**
 * One question as served to one attempt — the materialised row written once at attempt
 * start and never re-rolled (ADR-004).
 */
export type AttemptQuestionId = z.infer<typeof AttemptQuestionIdSchema>;

/** A candidate's answer to one served question. */
export const AnswerIdSchema = identifier<'AnswerId'>('AnswerId', 'Identifier of an answer.');
/** A candidate's answer to one served question. */
export type AnswerId = z.infer<typeof AnswerIdSchema>;

/** One execution of candidate code, whether a trial run or a graded submission. */
export const SubmissionIdSchema = identifier<'SubmissionId'>(
  'SubmissionId',
  'Identifier of a code submission.',
);
/** One execution of candidate code, whether a trial run or a graded submission. */
export type SubmissionId = z.infer<typeof SubmissionIdSchema>;

/** A live interview session. */
export const SessionIdSchema = identifier<'SessionId'>(
  'SessionId',
  'Identifier of a live interview session.',
);
/** A live interview session. */
export type SessionId = z.infer<typeof SessionIdSchema>;

/** An invitation to sit an assessment. Its plaintext token is returned exactly once. */
export const InvitationIdSchema = identifier<'InvitationId'>(
  'InvitationId',
  'Identifier of an invitation.',
);
/** An invitation to sit an assessment. Its plaintext token is returned exactly once. */
export type InvitationId = z.infer<typeof InvitationIdSchema>;

/** A skill in the taxonomy. */
export const SkillIdSchema = identifier<'SkillId'>('SkillId', 'Identifier of a skill.');
/** A skill in the taxonomy. */
export type SkillId = z.infer<typeof SkillIdSchema>;

/** A job role, which weights the skills an assessment should cover. */
export const JobRoleIdSchema = identifier<'JobRoleId'>('JobRoleId', 'Identifier of a job role.');
/** A job role, which weights the skills an assessment should cover. */
export type JobRoleId = z.infer<typeof JobRoleIdSchema>;

/** A completed or in-progress scorecard against a session or an attempt. */
export const ScorecardIdSchema = identifier<'ScorecardId'>(
  'ScorecardId',
  'Identifier of a scorecard.',
);
/** A completed or in-progress scorecard against a session or an attempt. */
export type ScorecardId = z.infer<typeof ScorecardIdSchema>;

/**
 * Every identifier schema, keyed by the component name it is published under in the
 * OpenAPI document. Exported so the generator cannot drift from the list above: a new
 * identifier appears in the document by being added here, not by being remembered.
 */
export const ID_SCHEMAS = {
  OrgId: OrgIdSchema,
  UserId: UserIdSchema,
  CandidateId: CandidateIdSchema,
  QuestionId: QuestionIdSchema,
  QuestionVersionId: QuestionVersionIdSchema,
  AssessmentId: AssessmentIdSchema,
  SectionId: SectionIdSchema,
  AttemptId: AttemptIdSchema,
  AttemptQuestionId: AttemptQuestionIdSchema,
  AnswerId: AnswerIdSchema,
  SubmissionId: SubmissionIdSchema,
  SessionId: SessionIdSchema,
  InvitationId: InvitationIdSchema,
  SkillId: SkillIdSchema,
  JobRoleId: JobRoleIdSchema,
  ScorecardId: ScorecardIdSchema,
} as const;
