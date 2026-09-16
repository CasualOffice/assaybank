/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/contracts — the root of the dependency graph.
 *
 * Owns: the branded identifier types, the shared request and response primitives (UUID,
 * RFC 3339 timestamp, cursor pagination), the closed `ErrorCode` union and error
 * envelope from docs/03-API-spec.md §2, and the generated OpenAPI 3.1 document.
 *
 * Imports no other workspace package and performs no I/O (CODE-GRAPH L3): it is consumed
 * by both servers and both browser bundles, so a dependency here would pull server code
 * into a client bundle. It reads no environment variable and no clock.
 *
 * A candidate-facing response schema must remain physically incapable of expressing a
 * hidden test-case expectation, a reference solution or an `is_correct` flag (FR-12).
 * That is enforced by there being two serialiser types rather than one type with a flag
 * (docs/17 §3), and those types are added here as the endpoints that need them arrive.
 *
 * Everything public is re-exported from this file; nothing imports a submodule directly.
 */

export {
  CursorSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PaginationQuerySchema,
  Rfc3339Schema,
  UuidSchema,
  paginated,
} from './primitives.js';
export type { Cursor, Paginated, PaginationQuery, Rfc3339, Uuid } from './primitives.js';

export {
  AnswerIdSchema,
  AssessmentIdSchema,
  AttemptIdSchema,
  AttemptQuestionIdSchema,
  CandidateIdSchema,
  ID_SCHEMAS,
  InvitationIdSchema,
  JobRoleIdSchema,
  OrgIdSchema,
  QuestionIdSchema,
  QuestionVersionIdSchema,
  ScorecardIdSchema,
  SectionIdSchema,
  SessionIdSchema,
  SkillIdSchema,
  SubmissionIdSchema,
  UserIdSchema,
} from './ids.js';
export type {
  AnswerId,
  AssessmentId,
  AttemptId,
  AttemptQuestionId,
  CandidateId,
  InvitationId,
  JobRoleId,
  OrgId,
  QuestionId,
  QuestionVersionId,
  ScorecardId,
  SectionId,
  SessionId,
  SkillId,
  SubmissionId,
  UserId,
} from './ids.js';

export {
  MAX_BRANDING_NAME_LENGTH,
  MAX_LOGO_URL_LENGTH,
  ORG_SETTINGS_PATH,
  OrgBrandingPatchSchema,
  OrgBrandingSchema,
  OrgIdentitySchema,
  OrgProctoringDefaultsPatchSchema,
  OrgProctoringDefaultsSchema,
  OrgSettingsPatchSchema,
  OrgSettingsResponseSchema,
  OrgSettingsSchema,
  defaultOrgSettings,
  mergeOrgSettings,
  projectOrgSettings,
} from './org-settings.js';
export type {
  OrgBranding,
  OrgProctoringDefaults,
  OrgSettings,
  OrgSettingsPatch,
  OrgSettingsResponse,
} from './org-settings.js';

export { ANSWER_KEY_FIELDS, findAnswerKeyFields } from './audience.js';
export type {
  AnswerKeyField,
  HasAnswerKeyField,
  IsCandidateSafe,
  Satisfied,
} from './audience.js';

export {
  AnswerKeyInputSchema,
  AuthorAnswerKeySchema,
  AuthorCodingSpecSchema,
  AuthorMcqOptionSchema,
  AuthorQuestionSchema,
  AuthorQuestionSummarySchema,
  AuthorQuestionVersionSchema,
  AuthorTestCaseSchema,
  CHOICE_KINDS,
  CODE_KINDS,
  CandidateChoiceQuestionSchema,
  CandidateCodingBriefSchema,
  CandidateCodingQuestionSchema,
  CandidateOptionSchema,
  CandidateProseQuestionSchema,
  CandidateQuestionSchema,
  CandidateShortAnswerQuestionSchema,
  CodingSpecInputSchema,
  CreateQuestionSchema,
  DifficultySchema,
  ExternalRefSchema,
  FIRST_VERSION_FIELDS,
  ListQuestionsQuerySchema,
  MAX_ANSWER_KEYS,
  MAX_DIFFICULTY,
  MAX_EXPLANATION_LENGTH,
  MAX_OPTIONS,
  MAX_PROMPT_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_TEST_CASES,
  MIN_DIFFICULTY,
  McqOptionInputSchema,
  PATCHABLE_STATUSES,
  PROMPT_EXCERPT_LENGTH,
  PROSE_KINDS,
  PatchQuestionSchema,
  QUESTIONS_PATH,
  QUESTION_KINDS,
  QUESTION_PATH,
  QUESTION_STATUSES,
  QUESTION_VERSIONS_PATH,
  QUESTION_VERSION_PATH,
  QUESTION_PREVIEW_PATH,
  QUESTION_STATS_PATH,
  QUESTION_VERSION_PUBLISH_PATH,
  QuestionKindSchema,
  QuestionListResponseSchema,
  QuestionParamsSchema,
  QuestionSkillSchema,
  QuestionStatusSchema,
  QuestionPreviewRequestSchema,
  hasAtMostTwoDecimals,
  MAX_SCORE_VALUE,
  MAX_WEIGHT_VALUE,
  scoreValue,
  QuestionStatsResponseSchema,
  QuestionVersionInputSchema,
  QuestionVersionListResponseSchema,
  QuestionVersionParamsSchema,
  SourceLicenseSchema,
  TestCaseInputSchema,
  toAuthorSummaryView,
  toAuthorVersionView,
  toAuthorView,
  toCandidateView,
} from './questions.js';
export type {
  AnswerKeyRecord,
  AuthorQuestionSummaryView,
  AuthorQuestionVersionView,
  AuthorQuestionView,
  CandidateChoiceQuestion,
  CandidateCodingQuestion,
  CandidateProseQuestion,
  CandidateQuestionView,
  CandidateShortAnswerQuestion,
  CodingSpecRecord,
  CreateQuestion,
  ListQuestionsQuery,
  McqOptionRecord,
  PatchQuestion,
  QuestionKind,
  QuestionListResponse,
  QuestionRecord,
  QuestionSkillRecord,
  QuestionStatus,
  QuestionSummaryRecord,
  QuestionPreviewRequest,
  QuestionStatsResponse,
  QuestionVersionInput,
  QuestionVersionListResponse,
  QuestionVersionParams,
  QuestionVersionRecord,
  TestCaseRecord,
} from './questions.js';

export {
  ApiError,
  ERROR_CODES,
  ERROR_CODE_MESSAGES,
  ERROR_CODE_STATUS,
  ErrorCodeSchema,
  ErrorDetailsSchema,
  ErrorEnvelopeSchema,
  INTERNAL_ERROR_MESSAGE,
  isErrorCode,
  statusForErrorCode,
  toErrorEnvelope,
} from './errors.js';
export type { ApiErrorOptions, ErrorCode, ErrorDetails, ErrorEnvelope } from './errors.js';

export { MAX_VALIDATION_FIELDS, parseRequestPart, validationFieldsFor } from './parse.js';
export type { RequestPart, ValidationField } from './parse.js';

export { API_BASE_PATH, buildOpenApiDocument } from './openapi.js';
export type { OpenApiDocument } from './openapi.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/contracts';

export * from './taxonomy.js';
