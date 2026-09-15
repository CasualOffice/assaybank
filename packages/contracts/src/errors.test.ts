/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  ApiError,
  ERROR_CODES,
  ERROR_CODE_MESSAGES,
  ERROR_CODE_STATUS,
  ErrorEnvelopeSchema,
  INTERNAL_ERROR_MESSAGE,
  isErrorCode,
  statusForErrorCode,
  toErrorEnvelope,
  type ErrorCode,
} from './index.js';

const REQUEST_ID = '0af7651916cd43dd8448eb211c80319c';

describe('ERROR_CODES', () => {
  it('is a closed set containing every code the documents define', () => {
    expect([...ERROR_CODES]).toEqual([
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
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('gives every code a status and a default message', () => {
    for (const code of ERROR_CODES) {
      expect(statusForErrorCode(code), code).toBeGreaterThanOrEqual(400);
      expect(statusForErrorCode(code), code).toBeLessThan(600);
      expect(ERROR_CODE_MESSAGES[code].length, code).toBeGreaterThan(0);
    }
  });

  it('maps the statuses the API specification states', () => {
    expect(ERROR_CODE_STATUS.unauthenticated).toBe(401);
    expect(ERROR_CODE_STATUS.forbidden).toBe(403);
    expect(ERROR_CODE_STATUS.not_found).toBe(404);
    expect(ERROR_CODE_STATUS.conflict).toBe(409);
    expect(ERROR_CODE_STATUS.version_immutable).toBe(409);
    expect(ERROR_CODE_STATUS.validation_failed).toBe(422);
    expect(ERROR_CODE_STATUS.rate_limited).toBe(429);
    expect(ERROR_CODE_STATUS.execution_unavailable).toBe(503);
    expect(ERROR_CODE_STATUS.internal).toBe(500);
  });

  it('narrows an unknown string with isErrorCode', () => {
    expect(isErrorCode('attempt_expired')).toBe(true);
    expect(isErrorCode('teapot')).toBe(false);
    expect(isErrorCode(409)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});

describe('ApiError', () => {
  it('carries the code, the status for that code, and the details', () => {
    const err = ApiError.attemptExpired(undefined, {
      details: { deadline_at: '2026-09-14T10:30:00Z' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('attempt_expired');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ deadline_at: '2026-09-14T10:30:00Z' });
    expect(err.message).toBe(ERROR_CODE_MESSAGES.attempt_expired);
    expect(err.name).toBe('ApiError');
  });

  it('accepts an authored message in place of the default', () => {
    const err = ApiError.notFound('No such assessment.');
    expect(err.message).toBe('No such assessment.');
    expect(err.status).toBe(404);
  });

  it('keeps the cause for the log without putting it in the envelope', () => {
    const cause = new Error('connection to postgres-primary refused');
    const err = ApiError.executionUnavailable(undefined, { cause });
    expect(err.cause).toBe(cause);
    expect(toErrorEnvelope(err, REQUEST_ID).error.message).not.toContain('postgres');
  });

  it('has a helper for every code, each producing that code', () => {
    const built: ApiError[] = [
      ApiError.unauthenticated(),
      ApiError.forbidden(),
      ApiError.notFound(),
      ApiError.validationFailed(),
      ApiError.conflict(),
      ApiError.rateLimited(),
      ApiError.attemptExpired(),
      ApiError.attemptAlreadySubmitted(),
      ApiError.attemptAnonymised(),
      ApiError.questionNotPublished(),
      ApiError.versionImmutable(),
      ApiError.translationImmutable(),
      ApiError.localeCoverageIncomplete(),
      ApiError.localeNotOffered(),
      ApiError.localeNotSupported(),
      ApiError.candidateIdentityConflict(),
      ApiError.candidateErased(),
      ApiError.executionUnavailable(),
      ApiError.internal(),
    ];

    expect(built.map((e) => e.code)).toEqual([...ERROR_CODES]);
    for (const err of built) {
      expect(err.status, err.code).toBe(ERROR_CODE_STATUS[err.code]);
    }
  });

  it('recognises an instance from another copy of this package', () => {
    // What a second loaded copy of the module would throw: a different class, same
    // registered marker. instanceof would say no; isApiError must say yes, or a
    // deliberate 409 degrades into a 500.
    const foreign = Object.assign(new Error('already submitted'), {
      [Symbol.for('assaybank.contracts.ApiError')]: true,
      code: 'attempt_already_submitted',
      status: 409,
      details: undefined,
    });

    expect(ApiError.isApiError(foreign)).toBe(true);
    expect(toErrorEnvelope(foreign, REQUEST_ID).error.code).toBe('attempt_already_submitted');
  });

  it('does not mistake an ordinary error for an ApiError', () => {
    expect(ApiError.isApiError(new Error('boom'))).toBe(false);
    expect(ApiError.isApiError({ code: 'not_found', status: 404 })).toBe(false);
    expect(ApiError.isApiError(null)).toBe(false);
    expect(ApiError.isApiError('not_found')).toBe(false);
  });

  it('serialises itself through toEnvelope', () => {
    const envelope = ApiError.versionImmutable().toEnvelope(REQUEST_ID);
    expect(envelope.error.code).toBe('version_immutable');
    expect(envelope.error.request_id).toBe(REQUEST_ID);
  });
});

describe('toErrorEnvelope', () => {
  it('produces exactly the envelope documented in docs/03 §2', () => {
    const envelope = toErrorEnvelope(
      ApiError.attemptExpired(undefined, { details: { deadline_at: '2026-09-14T10:30:00Z' } }),
      REQUEST_ID,
    );

    expect(envelope).toEqual({
      error: {
        code: 'attempt_expired',
        message: 'The deadline for this attempt has passed.',
        details: { deadline_at: '2026-09-14T10:30:00Z' },
        request_id: REQUEST_ID,
      },
    });
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(Object.keys(envelope)).toEqual(['error']);
  });

  it('omits details entirely when there are none, rather than emitting null', () => {
    const envelope = toErrorEnvelope(ApiError.forbidden(), REQUEST_ID);
    expect('details' in envelope.error).toBe(false);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      error: {
        code: 'forbidden',
        message: ERROR_CODE_MESSAGES.forbidden,
        request_id: REQUEST_ID,
      },
    });
  });

  it('uses the request id it is given, which is the trace id (docs/17 §9)', () => {
    expect(toErrorEnvelope(ApiError.notFound(), REQUEST_ID).error.request_id).toBe(REQUEST_ID);
  });

  // docs/14-threat-model.md names error-message leakage as a real path to hidden
  // test-case content. These are the cases that path is made of.
  describe('redaction of anything that is not an authored ApiError', () => {
    const leaky: ReadonlyArray<readonly [string, unknown]> = [
      [
        'a postgres error carrying SQL and a table name',
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "test_cases_pkey"\n' +
              'DETAIL: Key (id)=(3f2504e0) already exists.',
          ),
          { code: '23505', table: 'test_cases', severity: 'ERROR' },
        ),
      ],
      [
        'a TypeError from a bad property read',
        new TypeError("Cannot read properties of undefined (reading 'expected_stdout')"),
      ],
      [
        'an upstream fetch failure naming an internal host',
        new Error('connect ECONNREFUSED 10.0.3.14:8080 (exec-node-7)'),
      ],
      ['a raw string throw', 'hidden expected output: 42'],
      [
        'an object that merely looks like an envelope',
        { code: 'not_found', message: '/srv/app/answer-key.json missing' },
      ],
      ['null', null],
      ['undefined', undefined],
      ['a number', 500],
      ['an error with a stack', (() => new Error('stack carrier'))()],
    ];

    it.each(leaky)('redacts %s', (_name, thrown) => {
      const envelope = toErrorEnvelope(thrown, REQUEST_ID);

      expect(envelope).toEqual({
        error: {
          code: 'internal',
          message: INTERNAL_ERROR_MESSAGE,
          request_id: REQUEST_ID,
        },
      });
      expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);

      const serialised = JSON.stringify(envelope);
      for (const secret of [
        'test_cases',
        '23505',
        'expected_stdout',
        'ECONNREFUSED',
        '10.0.3.14',
        'exec-node-7',
        'hidden expected output',
        'answer-key',
        'at Object',
        'stack',
      ]) {
        expect(serialised).not.toContain(secret);
      }
    });

    it('never emits a code outside the closed set', () => {
      const rogue = Object.assign(new Error('rogue'), {
        [Symbol.for('assaybank.contracts.ApiError')]: true,
        code: 'sql_error_23505',
        status: 500,
        details: { table: 'test_cases' },
      });

      expect(toErrorEnvelope(rogue, REQUEST_ID)).toEqual({
        error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE, request_id: REQUEST_ID },
      });
    });

    it('serves the fixed message for an authored internal error too', () => {
      const err = ApiError.internal({ details: { table: 'test_cases' } });
      expect(toErrorEnvelope(err, REQUEST_ID)).toEqual({
        error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE, request_id: REQUEST_ID },
      });
    });

    it('falls back to the default message when an ApiError was given an empty one', () => {
      const err = new ApiError('forbidden', '');
      expect(toErrorEnvelope(err, REQUEST_ID).error.message).toBe(ERROR_CODE_MESSAGES.forbidden);
    });
  });
});

describe('ErrorEnvelopeSchema', () => {
  it('rejects an envelope whose code is not in the closed set', () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'kaboom', message: 'x', request_id: REQUEST_ID },
      }).success,
    ).toBe(false);
  });

  it('requires code, message and request_id', () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: 'not_found' } }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  it('round-trips a parsed envelope from the wire', () => {
    const wire: unknown = JSON.parse(
      JSON.stringify(toErrorEnvelope(ApiError.rateLimited(), REQUEST_ID)),
    );
    const parsed = ErrorEnvelopeSchema.parse(wire);
    const code: ErrorCode = parsed.error.code;
    expect(code).toBe('rate_limited');
  });
});
