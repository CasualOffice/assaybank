/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * OpenAPI 3.1 emission.
 *
 * The document is *generated from the zod schemas and never hand-maintained*
 * (project/P0-FOUNDATION-PLAN.md step 5). A hand-written document describes what
 * somebody believed the API did at the time they wrote it; a generated one cannot
 * disagree with the schemas the server actually validates against, because it is the
 * same objects.
 *
 * What lives here from P0 is the cross-cutting half of the contract: the primitives, the
 * identifiers, the error envelope, the two authentication schemes and the reusable error
 * responses. Route definitions arrive with the routes — `GET` and `PATCH /org/settings`
 * are the first of them (P1 step 7, `./org-settings.ts`), and the shape of that
 * registration is the pattern every endpoint from P2 onward follows: one `registerPath`
 * per operation, request and response bodies referencing the same zod schemas the server
 * parses with, and failures pointing at the shared error responses rather than restating
 * the envelope.
 */

import './openapi-extension.js';

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { ERROR_CODE_MESSAGES, ErrorCodeSchema, ErrorEnvelopeSchema } from './errors.js';
import { ID_SCHEMAS } from './ids.js';
import {
  ASSESSMENTS_PATH,
  ASSESSMENT_AUTO_PATH,
  AssessmentListResponseSchema,
  AssessmentPlanSchema,
  AssessmentSchema,
  CreateAssessmentSchema,
  JOB_ROLE_ASSESSMENT_PLAN_PATH,
} from './assessments.js';
import {
  ORG_SETTINGS_PATH,
  OrgSettingsPatchSchema,
  OrgSettingsResponseSchema,
} from './org-settings.js';
import { CursorSchema, PaginationQuerySchema, Rfc3339Schema, UuidSchema } from './primitives.js';
import {
  AuthorQuestionSchema,
  AuthorQuestionVersionSchema,
  CandidateQuestionSchema,
  CreateQuestionSchema,
  ListQuestionsQuerySchema,
  PatchQuestionSchema,
  QUESTIONS_PATH,
  QUESTION_PATH,
  QUESTION_VERSIONS_PATH,
  QUESTION_VERSION_PATH,
  QUESTION_VERSION_PUBLISH_PATH,
  QuestionListResponseSchema,
  QuestionParamsSchema,
  QuestionVersionInputSchema,
  QuestionVersionListResponseSchema,
  QuestionVersionParamsSchema,
} from './questions.js';

/**
 * The generated document. Typed from the generator rather than by importing
 * `openapi3-ts` directly, so this package declares exactly the two dependencies it
 * actually installs (ADR-001 keeps the dependency list short and graded).
 */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/** The versioned API root. `/api/v1` is a compatibility boundary (docs/17 §3). */
export const API_BASE_PATH = '/api/v1';

/** The reference every error response points at. */
const ERROR_ENVELOPE_REF = '#/components/schemas/ErrorEnvelope';

/**
 * The reusable error responses, named by the code they usually carry. A route
 * references one of these rather than restating the envelope, which is what keeps every
 * documented failure the same shape as every real one.
 */
const ERROR_RESPONSES = [
  ['Unauthenticated', 'unauthenticated'],
  ['Forbidden', 'forbidden'],
  ['NotFound', 'not_found'],
  ['Conflict', 'conflict'],
  ['ValidationFailed', 'validation_failed'],
  ['RateLimited', 'rate_limited'],
  ['InternalError', 'internal'],
] as const;

/**
 * Builds the OpenAPI 3.1 document.
 *
 * Deterministic and free of I/O: the registry is constructed fresh on every call, so two
 * calls produce an identical document and the CI drift check compares like with like.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  // The primitives are named here rather than at their definition: they are leaves,
  // and a component name on a leaf would turn every `format: uuid` in the document into
  // an indirection. The schemas that carry their own component name — the identifiers,
  // the error code, the error envelope, the pagination query — keep it at definition, so
  // a schema nested inside another emits a `$ref` instead of a second inline copy.
  registry.register('Uuid', UuidSchema);
  registry.register('Rfc3339Timestamp', Rfc3339Schema);
  registry.register('Cursor', CursorSchema);
  registry.register('PaginationQuery', PaginationQuerySchema);
  registry.register('ErrorCode', ErrorCodeSchema);
  registry.register('ErrorEnvelope', ErrorEnvelopeSchema);

  // Every branded identifier is published under its own component name. On the wire an
  // identifier is a UUID like any other; the distinct component is what documents which
  // one an endpoint expects, and it is generated from ID_SCHEMAS so a new identifier
  // cannot be added to the code and forgotten in the document.
  for (const [name, schema] of Object.entries(ID_SCHEMAS)) {
    registry.register(name, schema);
  }

  // docs/03 §1: two authentication domains that must not share credentials. They are
  // separate schemes here for the same reason they are separate credentials there.
  registry.registerComponent('securitySchemes', 'staffSession', {
    type: 'apiKey',
    in: 'cookie',
    name: 'assaybank_session',
    description:
      'Staff session cookie, issued after password or OIDC login. Staff endpoints ' +
      'additionally require an explicit permission per action.',
  });
  registry.registerComponent('securitySchemes', 'attemptToken', {
    type: 'http',
    scheme: 'bearer',
    description:
      'Candidate attempt token, scoped to exactly one attempt. It cannot read the ' +
      'question bank, another candidate, or any other org resource.',
  });

  for (const [name, code] of ERROR_RESPONSES) {
    registry.registerComponent('responses', name, {
      description: ERROR_CODE_MESSAGES[code],
      content: { 'application/json': { schema: { $ref: ERROR_ENVELOPE_REF } } },
    });
  }

  registerOrgSettings(registry);
  registerAssessments(registry);
  registerQuestionBank(registry);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Assaybank API',
      version: '1.0.0',
      description:
        'Technical hiring: async assessments, live coding interviews and proctored ' +
        'certification exams over one shared question bank. Errors carry a stable ' +
        '`code`; clients branch on it and never on `message`.',
      license: { name: 'MPL-2.0', url: 'https://mozilla.org/MPL/2.0/' },
    },
    servers: [{ url: API_BASE_PATH, description: 'Versioned API root.' }],
  });
}

/**
 * The failure responses every staff route can produce, as references to the shared
 * components above.
 *
 * Written once rather than per route: docs/03 §2 has one envelope, and a route that
 * documented a different shape for its 403 would be documenting a bug. `429` is included
 * on every staff route because the limiter in `apps/api/src/rate-limit.ts` is global —
 * an endpoint that does not opt into a scope still has the staff ceiling applied to it.
 */
const STAFF_ROUTE_ERRORS = {
  401: { $ref: '#/components/responses/Unauthenticated' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
  429: { $ref: '#/components/responses/RateLimited' },
  500: { $ref: '#/components/responses/InternalError' },
} as const;

/**
 * `GET` and `PATCH /org/settings` — docs/03 §13, and the first business endpoint the
 * document describes.
 *
 * Both are documented as requiring `staffSession`; the `org.admin` permission is stated
 * in the description rather than expressed in the security scheme, because OpenAPI's
 * scopes belong to OAuth flows and this API's permissions are rows in
 * `user_role_permissions` (FR-27). Writing them as scopes would imply a client could ask
 * for one.
 *
 * The `404` is not decoration. An organisation that row-level security did not admit
 * answers `not_found` rather than `forbidden`, because a 403 would confirm that some
 * other tenant holds the row — a cross-tenant disclosure made of nothing but a status
 * code (ADR-010).
 */
/**
 * Composing an assessment from a role (`H-179`, docs/18 §2.2).
 *
 * The plan is a `GET` and deliberately so: it answers "what would be composed, and can the
 * bank supply it" without writing anything, so a recruiter can look at the paper before
 * committing to it and looking costs nothing.
 */
function registerAssessments(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: JOB_ROLE_ASSESSMENT_PLAN_PATH,
    tags: ['Assessments'],
    summary: 'What would be composed for this role',
    description:
      'Derives section rules from the role’s required skills — one rule per skill, the ' +
      'count in proportion to its weight, the band the role declares — and reports how ' +
      'many published questions the bank currently holds for each. `feasible` is false ' +
      'when any rule asks for more than its band holds; the composition is still returned, ' +
      'so the caller can show which skills fall short. Writes nothing.',
    security: [{ staffSession: [] }],
    responses: {
      200: {
        description: 'The composition, and whether the bank can supply it.',
        content: { 'application/json': { schema: AssessmentPlanSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'post',
    path: ASSESSMENT_AUTO_PATH,
    tags: ['Assessments'],
    summary: 'Compose an assessment from a role and save it',
    description:
      'Composes exactly what the plan endpoint would, then writes it. Requires ' +
      '`assessment.write` and records one `audit_log` row. Refused with ' +
      '`validation_failed` when the bank cannot supply the composition — `details.shortfalls` ' +
      'names each skill with what was needed and what is available. The refusal is ' +
      'deliberate: the draw will not short-draw at attempt start (ADR-004), so an ' +
      'infeasible assessment fails for the first candidate rather than degrading.',
    request: {
      body: { content: { 'application/json': { schema: CreateAssessmentSchema } } },
    },
    security: [{ staffSession: [] }],
    responses: {
      201: {
        description: 'The assessment as composed.',
        content: { 'application/json': { schema: AssessmentSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'get',
    path: ASSESSMENTS_PATH,
    tags: ['Assessments'],
    summary: 'Every assessment this organisation has composed',
    security: [{ staffSession: [] }],
    responses: {
      200: {
        description: 'Assessments, newest first.',
        content: { 'application/json': { schema: AssessmentListResponseSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });
}

function registerOrgSettings(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: ORG_SETTINGS_PATH,
    tags: ['Admin'],
    summary: 'Read this organisation’s settings',
    description:
      'Returns the calling session’s own organisation and its settings. Requires the ' +
      '`org.admin` permission. The response is a projection of the stored settings ' +
      'document: fields this API does not define are never served, and fields it defines ' +
      'that the document does not carry are served as their defaults.',
    security: [{ staffSession: [] }],
    responses: {
      200: {
        description: 'The organisation’s settings as they now stand.',
        content: { 'application/json': { schema: OrgSettingsResponseSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: ORG_SETTINGS_PATH,
    tags: ['Admin'],
    summary: 'Change this organisation’s settings',
    description:
      'Partially updates the calling session’s own organisation settings. Requires the ' +
      '`org.admin` permission, and writes one `audit_log` row carrying the before and ' +
      'after states in the same transaction as the change. An unrecognised field is ' +
      'refused with `validation_failed` rather than ignored. Retention clocks are not ' +
      'settable here — see docs/11 §4.2.',
    security: [{ staffSession: [] }],
    request: {
      body: {
        required: true,
        description: 'The settings to change. Omitted fields are left as they are.',
        content: { 'application/json': { schema: OrgSettingsPatchSchema } },
      },
    },
    responses: {
      200: {
        description: 'The organisation’s settings after the change.',
        content: { 'application/json': { schema: OrgSettingsResponseSchema } },
      },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });
}

/**
 * The question bank — docs/03 §4, and the surface P2 builds.
 *
 * Seven operations over two resources, each naming the permission it requires in its
 * description for the reason given above: this API's permissions are rows in
 * `user_role_permissions` (FR-27), not OAuth scopes a client could ask for.
 *
 * Three things in here are worth reading as documentation rather than as plumbing.
 *
 * **`409 version_immutable` on `PATCH …/versions/{v}`.** ADR-003 says a published version
 * is frozen; the database trigger from migration 0001 is what enforces it and this status
 * is the friendly version of that exception, not a substitute for it. It is documented on
 * the operation so that a client author reads "edits create a new version" before writing
 * the retry loop rather than after.
 *
 * **Publishing is its own operation.** Not a `PATCH` setting `status: 'published'`, which
 * is why {@link PatchQuestionSchema} cannot express that value. A permission gate a
 * sibling endpoint routes around is not a gate.
 *
 * **{@link CandidateQuestionSchema} is registered although no route here serves it.** It
 * is the candidate half of the boundary (docs/17 §3) and it arrives in P3 attached to the
 * attempt endpoints. Publishing the component now means the difference between the two
 * audiences is visible in the document a client author reads — one schema carries
 * `is_correct`, `solution_code` and `expected_stdout`, the other is structurally
 * incapable of carrying any of them — rather than being an internal detail somebody has
 * to take on trust.
 */
function registerQuestionBank(registry: OpenAPIRegistry): void {
  // Registered so the component exists in the document from P2, ahead of the P3 routes
  // that serve it. See the note above.
  registry.register('CandidateQuestion', CandidateQuestionSchema);

  const questionParams = { params: QuestionParamsSchema };
  const versionParams = { params: QuestionVersionParamsSchema };

  registry.registerPath({
    method: 'get',
    path: QUESTIONS_PATH,
    tags: ['Question bank'],
    summary: 'List questions',
    description:
      'Cursor-paginated, newest first. Requires `question.read`. Filters are explicit ' +
      'query parameters, never a generic query language (docs/17 §3). Archived questions ' +
      'are excluded unless `include_archived` asks for them.',
    security: [{ staffSession: [] }],
    request: { query: ListQuestionsQuerySchema },
    responses: {
      200: {
        description: 'One page of the bank.',
        content: { 'application/json': { schema: QuestionListResponseSchema } },
      },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'post',
    path: QUESTIONS_PATH,
    tags: ['Question bank'],
    summary: 'Create a question',
    description:
      'Creates an empty question in `draft`. Requires `question.write`. Content arrives ' +
      'as its first version through `POST /questions/{id}/versions`, which is the same ' +
      'path an edit takes (ADR-003).',
    security: [{ staffSession: [] }],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: CreateQuestionSchema } },
      },
    },
    responses: {
      201: {
        description: 'The question as created.',
        content: { 'application/json': { schema: AuthorQuestionSchema } },
      },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'get',
    path: QUESTION_PATH,
    tags: ['Question bank'],
    summary: 'Read a question, current version expanded',
    description: 'Requires `question.read`.',
    security: [{ staffSession: [] }],
    request: questionParams,
    responses: {
      200: {
        description: 'The question and its current version.',
        content: { 'application/json': { schema: AuthorQuestionSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: QUESTION_PATH,
    tags: ['Question bank'],
    summary: 'Move a question through its lifecycle, or archive it',
    description:
      'Requires `question.write`. `status` may be `draft`, `review` or `retired`; ' +
      '`published` is not settable here because publishing is a distinct action ' +
      'requiring `question.publish`. An illegal transition is `409 conflict`.',
    security: [{ staffSession: [] }],
    request: {
      ...questionParams,
      body: { required: true, content: { 'application/json': { schema: PatchQuestionSchema } } },
    },
    responses: {
      200: {
        description: 'The question after the change.',
        content: { 'application/json': { schema: AuthorQuestionSchema } },
      },
      409: { $ref: '#/components/responses/Conflict' },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: QUESTION_PATH,
    tags: ['Question bank'],
    summary: 'Archive a question (soft delete)',
    description:
      'Sets `archived_at` from the server clock and answers the archived question. ' +
      'Requires `question.write`. Nothing is removed: attempts reference versions, and a ' +
      'hard delete would unexplain every score the question ever produced (ADR-003).',
    security: [{ staffSession: [] }],
    request: questionParams,
    responses: {
      200: {
        description: 'The question, now archived.',
        content: { 'application/json': { schema: AuthorQuestionSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'get',
    path: QUESTION_VERSIONS_PATH,
    tags: ['Question bank'],
    summary: 'List a question’s versions',
    description: 'Newest first, cursor-paginated. Requires `question.read`.',
    security: [{ staffSession: [] }],
    request: { ...questionParams, query: PaginationQuerySchema },
    responses: {
      200: {
        description: 'One page of versions.',
        content: { 'application/json': { schema: QuestionVersionListResponseSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'post',
    path: QUESTION_VERSIONS_PATH,
    tags: ['Question bank'],
    summary: 'Create the next version',
    description:
      'Requires `question.write`. Fields the body omits are copied forward from the ' +
      'previous version, so fixing a typo does not mean retyping the question; a named ' +
      'child collection replaces the previous one wholesale. The first version of a ' +
      'question must carry `prompt_md` and `difficulty`, because it has nothing to copy ' +
      'forward from.',
    security: [{ staffSession: [] }],
    request: {
      ...questionParams,
      body: {
        required: true,
        content: { 'application/json': { schema: QuestionVersionInputSchema } },
      },
    },
    responses: {
      201: {
        description: 'The new version, in draft.',
        content: { 'application/json': { schema: AuthorQuestionVersionSchema } },
      },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'get',
    path: QUESTION_VERSION_PATH,
    tags: ['Question bank'],
    summary: 'Read one version',
    description: 'Addressed by `version_no`, not by uuid. Requires `question.read`.',
    security: [{ staffSession: [] }],
    request: versionParams,
    responses: {
      200: {
        description: 'The version in full.',
        content: { 'application/json': { schema: AuthorQuestionVersionSchema } },
      },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: QUESTION_VERSION_PATH,
    tags: ['Question bank'],
    summary: 'Edit a draft version in place',
    description:
      'Requires `question.write`. Legal only while `published_at` is null. A `PATCH` ' +
      'against a published version answers `409` with code `version_immutable`: a ' +
      'published version is frozen, and the edit belongs in a new version (ADR-003, FR-1).',
    security: [{ staffSession: [] }],
    request: {
      ...versionParams,
      body: {
        required: true,
        content: { 'application/json': { schema: QuestionVersionInputSchema } },
      },
    },
    responses: {
      200: {
        description: 'The version after the edit.',
        content: { 'application/json': { schema: AuthorQuestionVersionSchema } },
      },
      409: { $ref: '#/components/responses/Conflict' },
      422: { $ref: '#/components/responses/ValidationFailed' },
      ...STAFF_ROUTE_ERRORS,
    },
  });

  registry.registerPath({
    method: 'post',
    path: QUESTION_VERSION_PUBLISH_PATH,
    tags: ['Question bank'],
    summary: 'Publish a version',
    description:
      'Requires `question.publish`. Irreversible for that version: `published_at` is set ' +
      'from the server clock and the row becomes read-only, enforced by a database ' +
      'trigger rather than by this API alone. The question becomes the published version’s ' +
      'current version and its status moves to `published`. Publishing an already ' +
      'published version is `409 conflict`.',
    security: [{ staffSession: [] }],
    request: versionParams,
    responses: {
      200: {
        description: 'The version, now frozen.',
        content: { 'application/json': { schema: AuthorQuestionVersionSchema } },
      },
      409: { $ref: '#/components/responses/Conflict' },
      ...STAFF_ROUTE_ERRORS,
    },
  });
}
