/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The error contract: docs/03-API-spec.md §2, docs/17 §3.
 *
 * ```json
 * {
 *   "error": {
 *     "code": "attempt_expired",
 *     "message": "The deadline for this attempt has passed.",
 *     "details": { "deadline_at": "2026-09-14T10:30:00Z" },
 *     "request_id": "0af7651916cd43dd8448eb211c80319c"
 *   }
 * }
 * ```
 *
 * Two rules carry the weight here.
 *
 * **`code` is stable, `message` is not.** Clients branch on `code`; `message` is prose
 * for a human and may be reworded, translated or shortened at any time without that
 * being a breaking change. `ERROR_CODES` is therefore a closed union, and adding to it
 * is a deliberate edit to this file rather than a string invented at a call site.
 *
 * **Nothing internal escapes.** docs/14-threat-model.md records error-message leakage as
 * a real path to hidden test-case content, so anything that is not a deliberately
 * authored `ApiError` becomes `internal` with a fixed message. No stack, no SQL
 * fragment, no upstream error text, no exception class name.
 */

import './openapi-extension.js';

import { z } from 'zod';

/**
 * The closed set of error codes. Every code here is introduced by a document:
 *
 * - docs/03-API-spec.md §2 — the common codes, plus `version_immutable` from §4.
 * - docs/08-i18n-and-localisation.md — the four locale codes and `translation_immutable`.
 * - docs/09-ats-integration.md §"conflicts" — `candidate_identity_conflict`, `candidate_erased`.
 * - docs/11-data-retention-and-dpia.md — `attempt_anonymised`.
 * - `internal`, which is what everything unrecognised becomes.
 *
 * Adding a code is an API change: it widens what a client must be prepared to see. Add
 * one only alongside the document that introduces it.
 */
export const ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  'attempt_expired',
  'attempt_already_submitted',
  'attempt_anonymised',
  'question_not_published',
  'version_immutable',
  'translation_immutable',
  'locale_coverage_incomplete',
  'locale_not_offered',
  'locale_not_supported',
  'candidate_identity_conflict',
  'candidate_erased',
  'execution_unavailable',
  'internal',
] as const;

/** One of the stable error codes a client is allowed to branch on. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The zod form of {@link ERROR_CODES}, for parsing an envelope received over the wire. */
export const ErrorCodeSchema = z
  .enum(ERROR_CODES)
  .describe('A stable error code. Clients branch on this value, never on the message.')
  .openapi('ErrorCode');

/** Narrows an unknown value to an {@link ErrorCode}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The HTTP status each code is served with.
 *
 * The mapping lives with the codes so that one code cannot arrive as a 409 from one
 * route and a 422 from another; `Record<ErrorCode, number>` makes a new code without a
 * status a compile error.
 */
export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  attempt_expired: 409,
  attempt_already_submitted: 409,
  attempt_anonymised: 409,
  question_not_published: 409,
  version_immutable: 409,
  translation_immutable: 409,
  locale_coverage_incomplete: 409,
  candidate_identity_conflict: 409,
  candidate_erased: 409,
  locale_not_offered: 422,
  locale_not_supported: 422,
  rate_limited: 429,
  execution_unavailable: 503,
  internal: 500,
});

/** The HTTP status code an {@link ErrorCode} is served with. */
export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_CODE_STATUS[code];
}

/**
 * The default human message for each code.
 *
 * These are deliberately dull and free of internal detail: a default message is what a
 * caller gets when it did not think about wording, so the safe wording has to be the
 * one that costs nothing to choose.
 */
export const ERROR_CODE_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  unauthenticated: 'Authentication is required.',
  forbidden: 'You do not have permission to perform this action.',
  not_found: 'The requested resource does not exist.',
  validation_failed: 'The request was not valid.',
  conflict: 'The request conflicts with the current state of the resource.',
  rate_limited: 'Too many requests. Retry after the interval in the Retry-After header.',
  attempt_expired: 'The deadline for this attempt has passed.',
  attempt_already_submitted: 'This attempt has already been submitted.',
  attempt_anonymised: 'This attempt has been anonymised and can no longer be re-graded.',
  question_not_published: 'This question version is not published.',
  version_immutable: 'A published question version cannot be modified.',
  translation_immutable: 'A published translation cannot be modified.',
  locale_coverage_incomplete: 'Some questions are not available in every offered locale.',
  locale_not_offered: 'That locale is not offered for this assessment.',
  locale_not_supported: 'That locale is not supported.',
  candidate_identity_conflict: 'Two candidate records claim the same person.',
  candidate_erased: 'This candidate record was erased and cannot be recreated.',
  execution_unavailable: 'Code execution is temporarily unavailable. Your work is saved.',
  internal: 'An unexpected error occurred.',
});

/**
 * The message served for anything that is not a deliberately authored {@link ApiError}.
 * Fixed, generic, and carrying nothing an attacker can learn from.
 */
export const INTERNAL_ERROR_MESSAGE = ERROR_CODE_MESSAGES.internal;

/**
 * Structured, machine-readable context for an error — `{ deadline_at }` on
 * `attempt_expired`, `{ field, allowed_range }` on `validation_failed`.
 *
 * Whatever goes in here is served to the client verbatim, so it is authored, never
 * forwarded from a lower layer.
 */
export type ErrorDetails = Record<string, unknown>;

/** The zod form of {@link ErrorDetails}. */
export const ErrorDetailsSchema = z
  .record(z.string(), z.unknown())
  .describe('Structured, client-actionable context. Authored per code, never forwarded.');

/**
 * The one error shape this API emits, on every route, for every failure.
 *
 * `request_id` is the trace id (docs/12, docs/17 §9), so a support ticket quoting it
 * resolves to a trace rather than to a search through logs.
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string().describe('Human-readable prose. May change; never branch on it.'),
      details: ErrorDetailsSchema.optional(),
      request_id: z.string().describe('The trace id of the request that failed.'),
    }),
  })
  .describe('The error envelope returned by every failing request (docs/03 §2).')
  .openapi('ErrorEnvelope');

/** The parsed error envelope. */
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/**
 * Marks an instance as an {@link ApiError} across module realms.
 *
 * `instanceof` is not sufficient: a monorepo can end up with two copies of this package
 * loaded (a built `dist` in one workspace, the source in another), and an error thrown
 * by one copy must still be recognised by the other. Getting that wrong turns a
 * deliberate `404` into a `500`, which is a correctness bug and a worse one than it
 * looks — a candidate would see "an unexpected error occurred" where they should see
 * "this attempt has already been submitted".
 */
const API_ERROR_MARKER: unique symbol = Symbol.for('assaybank.contracts.ApiError');

/** Options accepted by the {@link ApiError} constructor beyond the message. */
export interface ApiErrorOptions {
  /** Structured context served to the client. Authored, never forwarded. */
  details?: ErrorDetails;
  /** The underlying error, kept for the log and never serialised to a client. */
  cause?: unknown;
}

/**
 * An error a route deliberately decided to return.
 *
 * Anything else that reaches {@link toErrorEnvelope} is an accident, and accidents are
 * served as `internal` with no detail. That asymmetry is the whole design: the only way
 * for text to reach a client is for somebody to have written it here.
 */
export class ApiError extends Error {
  /** @see API_ERROR_MARKER */
  readonly [API_ERROR_MARKER] = true;

  override readonly name: string = 'ApiError';

  /** The stable code the client branches on. */
  readonly code: ErrorCode;

  /** The HTTP status this code is served with. */
  readonly status: number;

  /** Structured context, or `undefined` when there is none. */
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message?: string, options?: ApiErrorOptions) {
    super(
      message ?? ERROR_CODE_MESSAGES[code],
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.code = code;
    this.status = ERROR_CODE_STATUS[code];
    this.details = options?.details;
  }

  /** True when `value` is an `ApiError`, including one from another copy of this package. */
  static isApiError(value: unknown): value is ApiError {
    return typeof value === 'object' && value !== null && API_ERROR_MARKER in value;
  }

  /** Builds an `ApiError` for any code. The named helpers below are the usual entry points. */
  static of(code: ErrorCode, message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError(code, message, options);
  }

  /** 401 — no session, no attempt token, or an expired one. */
  static unauthenticated(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('unauthenticated', message, options);
  }

  /** 403 — authenticated, but this action is not permitted (FR-27). */
  static forbidden(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('forbidden', message, options);
  }

  /**
   * 404 — the resource does not exist, or does not exist *for this tenant*, which is
   * the same answer on purpose: a `403` here would confirm that another org holds the id.
   */
  static notFound(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('not_found', message, options);
  }

  /** 422 — the request body or query failed its schema. `details` names the field. */
  static validationFailed(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('validation_failed', message, options);
  }

  /** 409 — the request conflicts with current state and no specific code applies. */
  static conflict(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('conflict', message, options);
  }

  /** 429 — a rate limit in docs/03 §2 was exceeded. Served with `Retry-After`. */
  static rateLimited(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('rate_limited', message, options);
  }

  /**
   * 409 — the server-computed `deadline_at` has passed (ADR-006). `details.deadline_at`
   * carries the deadline so the client can say when, rather than guessing from its own
   * clock.
   */
  static attemptExpired(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('attempt_expired', message, options);
  }

  /** 409 — a second submit for an attempt that is already submitted. */
  static attemptAlreadySubmitted(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('attempt_already_submitted', message, options);
  }

  /** 409 — the attempt's personal data was erased, so it can no longer be re-graded (docs/11). */
  static attemptAnonymised(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('attempt_anonymised', message, options);
  }

  /** 409 — a draft question version was asked to do something only a published one can do. */
  static questionNotPublished(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('question_not_published', message, options);
  }

  /** 409 — a write against a published question version. Published is frozen (ADR-003). */
  static versionImmutable(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('version_immutable', message, options);
  }

  /** 409 — a write against a published translation (docs/08), mirroring `version_immutable`. */
  static translationImmutable(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('translation_immutable', message, options);
  }

  /** 409 — an offered locale is missing a published version for some question (docs/08). */
  static localeCoverageIncomplete(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('locale_coverage_incomplete', message, options);
  }

  /** 422 — the requested locale is not among the assessment's offered locales (docs/08). */
  static localeNotOffered(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('locale_not_offered', message, options);
  }

  /** 422 — the requested locale is not supported at all, rather than silently falling back. */
  static localeNotSupported(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('locale_not_supported', message, options);
  }

  /** 409 — two ATS records claim one human. Never auto-merged (docs/09). */
  static candidateIdentityConflict(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('candidate_identity_conflict', message, options);
  }

  /** 409 — a re-sync would resurrect a record a data subject asked to have deleted (docs/09). */
  static candidateErased(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('candidate_erased', message, options);
  }

  /**
   * 503 — the execution tier is unavailable. Never a zero score: the attempt is
   * preserved and a human picks it up (docs/17 §0 rule 4).
   */
  static executionUnavailable(message?: string, options?: ApiErrorOptions): ApiError {
    return new ApiError('execution_unavailable', message, options);
  }

  /**
   * 500 — an authored internal error. The message is fixed regardless of what is passed,
   * because a caller reaching for this code is by definition describing something the
   * client must not learn about.
   */
  static internal(options?: ApiErrorOptions): ApiError {
    return new ApiError('internal', INTERNAL_ERROR_MESSAGE, options);
  }

  /** This error as the envelope the client receives. */
  toEnvelope(requestId: string): ErrorEnvelope {
    return toErrorEnvelope(this, requestId);
  }
}

/**
 * Converts anything thrown anywhere into the one envelope this API emits.
 *
 * An {@link ApiError} is served as authored. **Everything else** — a `TypeError`, a
 * `postgres` error carrying a SQL fragment and a table name, a `fetch` failure naming an
 * internal host, a string, `undefined` — becomes `internal` with a fixed message and no
 * details. docs/14-threat-model.md names error-message leakage as a real path to hidden
 * test-case content, so this function is a security boundary and not a formatting helper.
 *
 * The cause is not discarded, it is simply not this function's business: the caller logs
 * the original error (with its stack, under the same trace id) and serves what this
 * returns.
 */
export function toErrorEnvelope(err: unknown, requestId: string): ErrorEnvelope {
  if (!ApiError.isApiError(err) || !isErrorCode(err.code) || err.code === 'internal') {
    return { error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE, request_id: requestId } };
  }

  const message =
    typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : ERROR_CODE_MESSAGES[err.code];

  return {
    error: {
      code: err.code,
      message,
      ...(err.details === undefined ? {} : { details: err.details }),
      request_id: requestId,
    },
  };
}
