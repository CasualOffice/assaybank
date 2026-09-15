/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ApiError } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { AUTH_ERROR_REASONS, AuthError } from './errors.js';

describe('AuthError', () => {
  it('keeps the reason on the server where a log line and a metric can use it', () => {
    const error = new AuthError('expired');

    expect(error.reason).toBe('expired');
    expect(error.name).toBe('AuthError');
    expect(error).toBeInstanceOf(Error);
  });

  it('tells the holder nothing about why they were refused', () => {
    // docs/14 T-011: expired, revoked, consumed, forged and never-existed must be
    // indistinguishable from outside, or `POST /candidate/redeem` becomes an oracle an
    // attacker can script against. Every reason therefore serves one identical envelope.
    const envelopes = AUTH_ERROR_REASONS.map((reason) =>
      new AuthError(reason).toApiError().toEnvelope('trace-id'),
    );

    const [first] = envelopes;
    expect(first).toBeDefined();

    for (const envelope of envelopes) {
      expect(envelope).toEqual(first);
      expect(envelope.error.code).toBe('unauthenticated');
      expect(envelope.error.details).toBeUndefined();
    }
  });

  it('serves a 401 rather than a 403 — the holder may simply need a new credential', () => {
    const served = new AuthError('signature_invalid').toApiError();

    expect(ApiError.isApiError(served)).toBe(true);
    expect(served.code).toBe('unauthenticated');
    expect(served.status).toBe(401);
  });

  it('keeps the original as the cause, so the log can say what the client cannot', () => {
    const original = new AuthError('attempt_mismatch');

    expect(original.toApiError().cause).toBe(original);
  });
});
