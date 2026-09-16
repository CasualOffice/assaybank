/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a failure becomes a response.
 *
 * Every route, every plugin, every unhandled throw arrives here and leaves as the
 * envelope of docs/03-API-spec.md §2, carrying the `request_id` of docs/12 §5.3. There
 * is no second formatting path, because a second path is how one endpoint ends up
 * answering `{ "message": … }` while the rest answer `{ "error": { … } }`.
 *
 * **This is a security boundary, not a formatter.** docs/14-threat-model.md records
 * error-message leakage as a real path to hidden test-case content: a `postgres` error
 * quotes the failing statement and its parameters — which, for an answer upsert, is the
 * candidate's answer — and a `fetch` failure names an internal host. So the asymmetry
 * that `toErrorEnvelope` enforces is the whole design: an `ApiError` somebody deliberately
 * authored is served as written, and *everything else* becomes `internal` with a fixed
 * message, no details, no stack, no exception class name, no upstream text.
 *
 * The cause is not discarded — it is logged, server-side, under the same trace id as the
 * response the client got, which is what makes the fixed public message affordable.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ApiError,
  MAX_VALIDATION_FIELDS,
  toErrorEnvelope,
  type ErrorDetails,
} from '@assaybank/contracts';

/**
 * Describes a schema failure in a form that carries no internal detail.
 *
 * Only two things cross: the request member that failed (`body/email`, `querystring/limit`)
 * and the rule it broke (`required`, `format`, `maximum`). Both are ours — they come from
 * the schema this service published, not from user input and not from a library's prose —
 * and together they are enough for a client developer to fix the call. The validator's
 * message is left out because "must match pattern ^(?=.*[A-Z])…" hands an attacker the
 * shape of a rule for free.
 *
 * The list is cut at `MAX_VALIDATION_FIELDS`, which comes from `@assaybank/contracts`
 * rather than being declared here: `parseRequestPart` builds the same `details.fields`
 * from a zod failure, and two bounds on one thing is one bound that is wrong.
 */
function validationDetails(error: FastifyError): ErrorDetails | undefined {
  const failures = error.validation;
  if (failures === undefined || failures.length === 0) return undefined;

  const part = typeof error.validationContext === 'string' ? error.validationContext : 'request';
  const fields = failures.slice(0, MAX_VALIDATION_FIELDS).map((failure) => ({
    field: `${part}${failure.instancePath}`,
    rule: failure.keyword,
  }));

  return { fields, truncated: failures.length > MAX_VALIDATION_FIELDS };
}

/**
 * Turns anything thrown into the `ApiError` that will be served.
 *
 * Fastify raises a handful of failures before any of our code runs — a malformed JSON
 * body, an unsupported content type, a payload over `bodyLimit`, a 429 from the limiter.
 * They carry a `statusCode` but not one of our codes, so they are mapped here rather than
 * collapsing into `internal`: a client that sent bad JSON deserves `validation_failed`,
 * not "an unexpected error occurred".
 *
 * Anything with no recognised status is `internal` by construction. Note that the
 * original error is passed as `cause` in every branch, so the log line below still has
 * the real failure even where the client is told nothing.
 */
export function normaliseError(error: FastifyError): ApiError {
  if (ApiError.isApiError(error)) return error;

  const details = validationDetails(error);
  if (details !== undefined) {
    return ApiError.validationFailed(undefined, { details, cause: error });
  }

  switch (error.statusCode) {
    case 400:
      return ApiError.validationFailed(undefined, { cause: error });
    case 401:
      return ApiError.unauthenticated(undefined, { cause: error });
    case 403:
      return ApiError.forbidden(undefined, { cause: error });
    case 404:
      return ApiError.notFound(undefined, { cause: error });
    case 405:
    case 406:
    case 413:
    case 415:
      return ApiError.validationFailed(undefined, { cause: error });
    case 429:
      return ApiError.rateLimited(undefined, { cause: error });
    default:
      return ApiError.internal({ cause: error });
  }
}

/**
 * Logs the failure with everything the public response withholds.
 *
 * 5xx is `error` and 4xx is `warn`, because a 404 is a client telling you about itself
 * and a 500 is the service telling you about itself, and paging on the first teaches
 * people to ignore the second. `err` goes through the observability serialiser, which
 * applies the redaction deny-list of docs/12 §7.2 to the message and the stack.
 */
function logFailure(request: FastifyRequest, apiError: ApiError, original: unknown): void {
  const payload = {
    event: 'http.request_failed',
    err: original,
    error_code: apiError.code,
    status: apiError.status,
    method: request.method,
    route_class: request.routeOptions.url ?? 'unmatched',
  };

  if (apiError.status >= 500) {
    request.log.error(payload, 'request failed');
  } else {
    request.log.warn(payload, 'request refused');
  }
}

/** Serves an already-normalised failure. */
function send(request: FastifyRequest, reply: FastifyReply, apiError: ApiError): void {
  void reply
    .code(apiError.status)
    .type('application/json; charset=utf-8')
    .send(toErrorEnvelope(apiError, request.requestId));
}

/**
 * Installs the error, not-found and validation handling on `app`.
 *
 * Fastify routes schema failures through the same error handler with `error.validation`
 * populated, so there is one handler rather than two that could disagree; the not-found
 * handler is separate only because Fastify models a missing route as a route rather than
 * as an error.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const apiError = normaliseError(error);
    logFailure(request, apiError, error);
    send(request, reply, apiError);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // `not_found` rather than `forbidden`, everywhere, including for a resource that
    // exists in another organisation: a 403 there would confirm that somebody else holds
    // the id, which is a cross-tenant disclosure made of nothing but a status code
    // (ADR-010, and the `notFound` doc comment in @assaybank/contracts).
    const apiError = ApiError.notFound();
    request.log.info(
      {
        event: 'http.route_not_found',
        method: request.method,
        // The URL is deliberately absent: it is attacker-controlled, it is logged in the
        // access line already, and docs/12 §6 keeps it out of anything label-shaped.
      },
      'no route matched',
    );
    send(request, reply, apiError);
  });
}
