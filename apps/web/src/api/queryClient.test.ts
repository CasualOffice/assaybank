/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ErrorCode } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { ApiRequestError } from './client.js';
import { createQueryClient, MAX_QUERY_RETRIES, shouldRetryQuery } from './queryClient.js';

function failureWith(code: ErrorCode, status: number): ApiRequestError {
  return new ApiRequestError({ error: { code, message: 'prose', request_id: 'r' } }, status);
}

describe('shouldRetryQuery', () => {
  it.each<[ErrorCode, number]>([
    ['rate_limited', 429],
    ['execution_unavailable', 503],
    ['internal', 500],
  ])('retries %s, which can come good on its own', (code, status) => {
    expect(shouldRetryQuery(0, failureWith(code, status))).toBe(true);
  });

  it.each<[ErrorCode, number]>([
    ['forbidden', 403],
    ['unauthenticated', 401],
    ['not_found', 404],
    ['validation_failed', 422],
    ['version_immutable', 409],
    ['attempt_already_submitted', 409],
  ])('does not retry %s, which will never succeed on repetition', (code, status) => {
    // Repeating a request the server has already refused on its merits is noise against
    // the rate limiter and a slower error for the user.
    expect(shouldRetryQuery(0, failureWith(code, status))).toBe(false);
  });

  it('stops once the attempt ceiling is reached', () => {
    const failure = failureWith('rate_limited', 429);

    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, failure)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, failure)).toBe(false);
    // A retry without a ceiling turns a blip into an outage (docs/17 §12).
    expect(shouldRetryQuery(MAX_QUERY_RETRIES + 5, failure)).toBe(false);
  });

  it('does not retry a failure from this bundle rather than from the API', () => {
    // A parser throwing on an unexpected shape will throw identically next time.
    expect(shouldRetryQuery(0, new TypeError('x is not a function'))).toBe(false);
    expect(shouldRetryQuery(0, 'boom')).toBe(false);
    expect(shouldRetryQuery(0, undefined)).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('returns a fresh client each time, so nothing is shared between sessions', () => {
    // A cache that outlives a sign-out is a cache that can show one user another user's
    // data. P1's login work discards the client rather than pruning it.
    expect(createQueryClient()).not.toBe(createQueryClient());
  });

  it('never retries a mutation automatically', () => {
    const defaults = createQueryClient().getDefaultOptions();

    // Every mutating endpoint accepts an Idempotency-Key (docs/03 §2). Until a call site
    // supplies one, a blind retry is a second invitation sent.
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('uses the code-aware retry policy for queries', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
  });

  it('does not re-issue every query when the window regains focus', () => {
    expect(createQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
