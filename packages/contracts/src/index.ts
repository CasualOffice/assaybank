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

export { API_BASE_PATH, buildOpenApiDocument } from './openapi.js';
export type { OpenApiDocument } from './openapi.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/contracts';
