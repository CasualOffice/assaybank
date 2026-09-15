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
 * What lives here in P0 is the cross-cutting half of the contract: the primitives, the
 * identifiers, the error envelope, the two authentication schemes and the reusable error
 * responses. Route definitions arrive with the routes.
 */

import './openapi-extension.js';

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { ERROR_CODE_MESSAGES, ErrorCodeSchema, ErrorEnvelopeSchema } from './errors.js';
import { ID_SCHEMAS } from './ids.js';
import { CursorSchema, PaginationQuerySchema, Rfc3339Schema, UuidSchema } from './primitives.js';

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
