/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/db — Drizzle schema, migrations, row-level-security policies and seed data.
 *
 * Owns: the tables modelling docs/hiring_platform_schema.sql, the forward-only
 * expand-contract migration runner, `withOrg(orgId)` which scopes a transaction to one
 * organisation, and the generated RLS isolation suite in `tests/rls.test.ts`.
 *
 * Every tenant table carries org_id and an org_isolation policy; a table added without
 * one fails both the completeness check in migration 0002 and the generated suite
 * (ADR-010), and `tests/rls.test.ts` proves that by building such a table and watching
 * both catch it. No export hands out a raw connection that bypasses app.current_org —
 * `withOrg` and `withElevated` are the entire query surface, and the pools are held in a
 * module-private WeakMap so there is nothing else to reach for. `withOrg` additionally
 * refuses a connection that arrived carrying a previous checkout's organisation, and
 * `withElevated` writes its own audit_log row inside the transaction it elevates.
 *
 * It also owns the audit writer. `writeAudit(tx, entry)` takes a transaction and never a
 * pool, so an audit row can only be written in the same transaction as the action it
 * records; migration 0004 makes the table append-only with a trigger that binds the
 * owner as well as the application roles, and refuses to store a voiding, an override, a
 * re-grade or an elevated access with no reason (FR-21, FR-25, ADR-010).
 *
 * From P2 it also owns the question-bank repository: `createQuestion`, `listQuestions`
 * and the version functions that ADR-003 turns on. `createVersion` copies forward from
 * the previous version rather than demanding a complete body, because an edit that means
 * retyping the question is an edit that introduces a second difference nobody asked for —
 * the merge is pure and lives in `version-content.ts` so the whole of that behaviour is
 * provable without a database. Every write against a version carries
 * `AND published_at IS NULL`, so the API answers `409 version_immutable` instead of
 * provoking the trigger that migrations 0001 and 0007 install; the guard is the polite
 * path and the trigger is the guarantee.
 *
 * Contains no business rules. Deciding *which* rows to read is the caller's job, and
 * whether a lifecycle transition is legal is `@assaybank/core-domain`'s; this package
 * only guarantees that the rows it can reach belong to the right tenant, and that
 * whatever it did to them is on the record.
 */

export {
  AUDIT_ACTOR_ATTEMPT_KEY,
  AUDIT_REASON_KEY,
  AuditEntryError,
  AuditReasonRequiredError,
  CANDIDATE_ACTION_PREFIX,
  JOB_ACTION_PREFIX,
  MAX_ACTION_LENGTH,
  MAX_ENTITY_TYPE_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_REASON_LENGTH,
  REASON_REQUIRED_ACTIONS,
  isAuditableAddress,
  prepareAuditEntry,
  requiresReason,
  writeAudit,
} from './audit.js';
export type {
  AuditActor,
  AuditEntry,
  AuditEntryId,
  AuditPayload,
  PreparedAuditEntry,
  ReasonRequiredAction,
} from './audit.js';

export { createDb, OrgContextLeakError, PLATFORM_ORG_ID, withElevated, withOrg } from './client.js';
export type {
  Database,
  DbConfig,
  DbOptions,
  DbTransaction,
  Elevation,
  ElevationRecord,
} from './client.js';

export { decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';
export type { Keyset } from './cursor.js';

export {
  archiveQuestion,
  createQuestion,
  createVersion,
  getLatestVersion,
  getQuestionWithCurrentVersion,
  getVersion,
  listQuestions,
  listVersions,
  publishVersion,
  restoreQuestion,
  retireQuestion,
  setQuestionSkills,
  setQuestionStatus,
  updateVersion,
} from './questions.js';
export type {
  CreateQuestionInput,
  Page,
  ReadQuestionOptions,
  ReadVersionOptions,
  VersionAuthorship,
} from './questions.js';

export { mergeVersionContent, missingFirstVersionFields } from './version-content.js';
export type {
  AnswerKeyContent,
  CodingSpecContent,
  McqOptionContent,
  TestCaseContent,
  VersionContent,
} from './version-content.js';

export { SEED_PERMISSIONS, SEED_ROLES, SEED_SKILLS, seed } from './seed.js';
export type { SeedOptions, SeedPermission, SeedResult, SeedRole, SeedSkill } from './seed.js';

export { MIGRATIONS_DIR, migrate } from './migrate.js';
export type { MigrateOptions, MigrateResult } from './migrate.js';

export {
  ALL_TABLES,
  DERIVED_TENANT_TABLES,
  GLOBAL_ROW_TABLES,
  RLS_EXEMPT_TABLES,
  TENANT_KEY_COLUMN,
  TENANT_ROOT_TABLE,
  TENANT_TABLES,
} from './rls-tables.js';

export * from './schema/index.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/db';

export {
  createSkill,
  getJobRoleCoverage,
  listSkills,
  mergeSkills,
  SkillMergeError,
  SkillNotFoundError,
  TaxonomyDepthError,
} from './taxonomy.js';
export type { CoverageRow, ListSkillsFilter, MergeSkillsResult, SkillRow } from './taxonomy.js';

export {
  advanceImport,
  claimBankJobs,
  createBankJob,
  failBankJob,
  finishBankJob,
  getBankJob,
  MAX_BANK_JOB_BYTES,
  MAX_STORED_PROBLEMS,
  readBankJobInput,
  readBankJobResult,
  recordParseProblems,
  startBankJob,
} from './bank-jobs.js';
export type {
  BankJobFormat,
  BankJobKind,
  BankJobRow,
  BankJobStatus,
  CreateBankJobInput,
  StoredProblem,
} from './bank-jobs.js';

export {
  createJobRole,
  getJobRole,
  getJobRoleSkills,
  invisibleSkillIds,
  listJobRoles,
  setJobRoleSkills,
  updateJobRole,
} from './job-roles.js';
export type {
  CreateJobRoleRecord,
  JobRolePatch,
  JobRoleRow,
  JobRoleSkillInputRow,
  JobRoleSkillRow,
  ListJobRolesFilter,
} from './job-roles.js';

export {
  getQuestionStats,
  listOrganisationIds,
  readItemResponses,
  upsertQuestionStats,
} from './question-stats.js';
export type { ItemResponseRow, QuestionStatsRow, StoredQuestionStats } from './question-stats.js';
