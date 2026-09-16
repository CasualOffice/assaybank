/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The whole Drizzle schema, split by the sections of
 * `docs/hiring_platform_schema.sql` — which remains the documentation of this model
 * while `../../migrations/` is now its source of truth (P0 step 6).
 *
 * Everything is re-exported by name for query code, and collected into a single
 * {@link schema} object for the places that need the map rather than a member:
 * `drizzle(client, { schema })`, and `src/rls-tables.ts`, which derives `TENANT_TABLES`
 * by walking it. A table that is not in this object is a table the RLS suite does not
 * cover, so a new section file must be re-exported here in the same change that creates
 * it.
 */

export { bytea, citext, tstz } from './columns.js';

export {
  organizations,
  orgRef,
  optionalOrgRef,
  users,
  userRoles,
  permissions,
  userRolePermissions,
  userRoleAssignments,
} from './tenancy-rbac.js';
export { staffAccounts, staffVerifications } from './staff-identity.js';
export { skills } from './skills.js';
export { jobRoles, jobRoleSkills, jobOpenings } from './job-roles.js';
export {
  questionKind,
  questionStatus,
  questions,
  questionVersions,
  questionSkills,
  mcqOptions,
  codingSpecs,
  testCases,
  shortAnswerKeys,
  questionStats,
} from './question-bank.js';
export { assessments, assessmentSections, sectionQuestions, sectionRules } from './assessments.js';
export {
  candidates,
  applications,
  invitations,
  attemptStatus,
  attempts,
  attemptQuestions,
  answers,
} from './candidates-attempts.js';
export { submissions, submissionResults } from './execution.js';
export { interviewSessions, sessionParticipants, sessionEvents } from './interviews.js';
export {
  scorecardTemplates,
  scorecardCriteria,
  scorecards,
  scorecardRatings,
} from './scorecards.js';
export { proctorEvents, proctorMedia, auditLog } from './proctoring-audit.js';
export { bankJobs } from './bank-jobs.js';

import {
  organizations,
  users,
  userRoles,
  permissions,
  userRolePermissions,
  userRoleAssignments,
} from './tenancy-rbac.js';
import { skills } from './skills.js';
import { jobRoles, jobRoleSkills, jobOpenings } from './job-roles.js';
import {
  questions,
  questionVersions,
  questionSkills,
  mcqOptions,
  codingSpecs,
  testCases,
  shortAnswerKeys,
  questionStats,
} from './question-bank.js';
import { assessments, assessmentSections, sectionQuestions, sectionRules } from './assessments.js';
import {
  candidates,
  applications,
  invitations,
  attempts,
  attemptQuestions,
  answers,
} from './candidates-attempts.js';
import { submissions, submissionResults } from './execution.js';
import { interviewSessions, sessionParticipants, sessionEvents } from './interviews.js';
import {
  scorecardTemplates,
  scorecardCriteria,
  scorecards,
  scorecardRatings,
} from './scorecards.js';
import { proctorEvents, proctorMedia, auditLog } from './proctoring-audit.js';
import { staffAccounts, staffVerifications } from './staff-identity.js';
import { bankJobs } from './bank-jobs.js';

/**
 * Every table in the model, keyed by its Drizzle export name.
 *
 * Forty-three tables: the forty of `docs/hiring_platform_schema.sql`, plus the two that
 * staff authentication needs and the schema file never had — see `./staff-identity.ts`
 * for why they are separate and why they are both tenant tables — and `bank_jobs`, the
 * import and export outbox (ADR-021). `src/schema/schema.test.ts`
 * asserts the count, and `infra/postgres/init/03-rls.sql` accounts for the original forty.
 * Enums are deliberately absent: this object is walked to find tables, and a `pgEnum` is
 * not one.
 */
export const schema = {
  // 1 — tenancy, users, RBAC
  organizations,
  users,
  userRoles,
  permissions,
  userRolePermissions,
  userRoleAssignments,
  // 1a — staff authentication (Better Auth; not in docs/hiring_platform_schema.sql)
  staffAccounts,
  staffVerifications,
  // 2 — skill taxonomy
  skills,
  // 3 — job roles
  jobRoles,
  jobRoleSkills,
  jobOpenings,
  // 4 — question bank
  questions,
  questionVersions,
  questionSkills,
  mcqOptions,
  codingSpecs,
  testCases,
  shortAnswerKeys,
  questionStats,
  // 4a — bank import and export jobs (migration 0010; not in docs/hiring_platform_schema.sql's forty)
  bankJobs,
  // 5 — assessments
  assessments,
  assessmentSections,
  sectionQuestions,
  sectionRules,
  // 6 — candidates, invitations, attempts
  candidates,
  applications,
  invitations,
  attempts,
  attemptQuestions,
  answers,
  // 7 — code execution
  submissions,
  submissionResults,
  // 8 — live interviews
  interviewSessions,
  sessionParticipants,
  sessionEvents,
  // 9 — scorecards
  scorecardTemplates,
  scorecardCriteria,
  scorecards,
  scorecardRatings,
  // 10 — proctoring and audit
  proctorEvents,
  proctorMedia,
  auditLog,
} as const;

/** The type of {@link schema}, for `PostgresJsDatabase<Schema>` and query builders. */
export type Schema = typeof schema;
