/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FastifyError } from 'fastify';
import { describe, expect, it } from 'vitest';

import { ApiError, toErrorEnvelope } from '@assaybank/contracts';

import { normaliseError } from './errors.js';

function fastifyError(overrides: Partial<FastifyError> & { message?: string }): FastifyError {
  const error = new Error(overrides.message ?? 'boom') as FastifyError;
  return Object.assign(error, { code: 'TEST', name: 'FastifyError' }, overrides);
}

describe('normaliseError', () => {
  it('passes an authored ApiError through untouched', () => {
    const authored = ApiError.attemptExpired(undefined, {
      details: { deadline_at: '2026-09-14T10:30:00Z' },
    });

    expect(normaliseError(authored as unknown as FastifyError)).toBe(authored);
  });

  it('maps a schema failure to validation_failed and names the member', () => {
    const error = fastifyError({
      validationContext: 'body',
      validation: [
        { keyword: 'required', instancePath: '', schemaPath: '#/required', params: {} },
        { keyword: 'format', instancePath: '/email', schemaPath: '#/format', params: {} },
      ],
    });

    const normalised = normaliseError(error);

    expect(normalised.code).toBe('validation_failed');
    expect(normalised.status).toBe(422);
    expect(normalised.details).toEqual({
      fields: [
        { field: 'body', rule: 'required' },
        { field: 'body/email', rule: 'format' },
      ],
      truncated: false,
    });
  });

  it('never forwards the validator prose', () => {
    const error = fastifyError({
      validationContext: 'body',
      validation: [
        {
          keyword: 'pattern',
          instancePath: '/token',
          schemaPath: '#/pattern',
          params: { pattern: '^(?=.*[A-Z])secret-internal-rule$' },
          message: 'must match pattern "^(?=.*[A-Z])secret-internal-rule$"',
        },
      ],
    });

    // A rule's own text hands an attacker the shape of the rule for free.
    expect(JSON.stringify(normaliseError(error).details)).not.toContain('secret-internal-rule');
  });

  it('maps the statuses Fastify raises before any handler runs', () => {
    expect(normaliseError(fastifyError({ statusCode: 400 })).code).toBe('validation_failed');
    expect(normaliseError(fastifyError({ statusCode: 401 })).code).toBe('unauthenticated');
    expect(normaliseError(fastifyError({ statusCode: 403 })).code).toBe('forbidden');
    expect(normaliseError(fastifyError({ statusCode: 404 })).code).toBe('not_found');
    expect(normaliseError(fastifyError({ statusCode: 413 })).code).toBe('validation_failed');
    expect(normaliseError(fastifyError({ statusCode: 415 })).code).toBe('validation_failed');
    expect(normaliseError(fastifyError({ statusCode: 429 })).code).toBe('rate_limited');
  });

  it('collapses anything unrecognised to internal, keeping the cause for the log', () => {
    const cause = fastifyError({ message: 'relation "answers" does not exist' });

    const normalised = normaliseError(cause);

    expect(normalised.code).toBe('internal');
    expect(normalised.status).toBe(500);
    expect(normalised.cause).toBe(cause);
    // And the envelope built from it says nothing about the cause.
    expect(JSON.stringify(toErrorEnvelope(normalised, 'req_0'))).not.toContain('answers');
  });
});
