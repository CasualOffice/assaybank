/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parseRequestPart` — the edge parse, and the shape of the 422 it produces.
 *
 * What is under test is mostly what the response *does not* carry: no validator prose,
 * no offending value, no unbounded list. Those are the properties that make a 422 safe
 * to serve to an unauthenticated caller, and each of them is one careless `message:`
 * away from not holding.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ApiError,
  MAX_VALIDATION_FIELDS,
  parseRequestPart,
  validationFieldsFor,
  type ValidationField,
} from './index.js';

const Body = z.strictObject({
  name: z.string().min(1).max(10),
  colour: z.string().regex(/^#[0-9a-f]{6}$/u, 'A colour is six lower-case hexadecimal digits.'),
  count: z.number().int().max(5).optional(),
});

/** Runs the parse and returns whatever was thrown, so each case can assert on it. */
function refusal(value: unknown): ApiError {
  try {
    parseRequestPart(Body, value, 'body');
  } catch (error: unknown) {
    if (ApiError.isApiError(error)) return error;
    throw error;
  }
  throw new Error('the parse was expected to fail and did not');
}

function fieldsOf(error: ApiError): ValidationField[] {
  return (error.details?.['fields'] ?? []) as ValidationField[];
}

describe('parseRequestPart()', () => {
  it('returns the parsed value, so the caller has a type it earned', () => {
    expect(parseRequestPart(Body, { name: 'acme', colour: '#1f6feb' }, 'body')).toEqual({
      name: 'acme',
      colour: '#1f6feb',
    });
  });

  it('throws validation_failed, which is a 422 in the documented envelope', () => {
    const error = refusal({ name: '', colour: '#1f6feb' });
    expect(error.code).toBe('validation_failed');
    expect(error.status).toBe(422);
  });

  it('names the failing member, rooted at the request part', () => {
    expect(fieldsOf(refusal({ name: 'acme', colour: 'blue' }))).toEqual([
      { field: 'body/colour', rule: 'invalid_format' },
    ]);
  });

  it('names an unrecognised key rather than the object that carried it', () => {
    // zod reports this issue against the object, with the key in `keys`. Joining the
    // path would answer "body", which points a client at the wrong place entirely.
    expect(fieldsOf(refusal({ name: 'acme', colour: '#1f6feb', retention_days: 30 }))).toEqual([
      { field: 'body/retention_days', rule: 'unrecognized_keys' },
    ]);
  });

  it('carries no validator prose and no offending value', () => {
    const error = refusal({ name: 'acme', colour: 'javascript:alert(1)' });
    const serialised = JSON.stringify(error.details);

    // The rule's own text would hand an attacker the shape of the check for free, and
    // the value is user-controlled text that must never be reflected (docs/14).
    expect(serialised).not.toContain('hexadecimal');
    expect(serialised).not.toContain('javascript:');
    expect(error.message).toBe('The request was not valid.');
  });

  it('keeps the original error as the cause, for the log the client never sees', () => {
    expect(refusal({}).cause).toBeInstanceOf(z.ZodError);
  });

  it('bounds the list and says when it cut it', () => {
    const Wide = z.object(
      Object.fromEntries(
        Array.from({ length: MAX_VALIDATION_FIELDS + 5 }, (_, index) => [
          `field_${String(index)}`,
          z.string(),
        ]),
      ),
    );

    let thrown: ApiError | undefined;
    try {
      parseRequestPart(Wide, {}, 'body');
    } catch (error: unknown) {
      thrown = ApiError.isApiError(error) ? error : undefined;
    }

    expect(thrown).toBeDefined();
    expect(fieldsOf(thrown as ApiError)).toHaveLength(MAX_VALIDATION_FIELDS);
    expect(thrown?.details?.['truncated']).toBe(true);
  });

  it('does not claim truncation when it did not truncate', () => {
    expect(refusal({ name: 'acme', colour: 'blue' }).details?.['truncated']).toBe(false);
  });
});

describe('validationFieldsFor()', () => {
  it('roots the path at whichever request part was parsed', () => {
    const outcome = z.object({ limit: z.number() }).safeParse({ limit: 'all' });
    expect(outcome.success).toBe(false);
    expect(validationFieldsFor(outcome.error?.issues ?? [], 'querystring')).toEqual([
      { field: 'querystring/limit', rule: 'invalid_type' },
    ]);
  });

  it('renders a nested path with slashes, as the ajv-produced failures do', () => {
    const nested = z.object({ branding: z.object({ logo_url: z.string() }) });
    const outcome = nested.safeParse({ branding: { logo_url: 42 } });
    expect(validationFieldsFor(outcome.error?.issues ?? [], 'body')).toEqual([
      { field: 'body/branding/logo_url', rule: 'invalid_type' },
    ]);
  });
});
