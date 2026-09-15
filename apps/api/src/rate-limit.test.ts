/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  MAX_SUBMISSIONS_PER_ATTEMPT_QUESTION,
  RATE_LIMITS,
  RATE_LIMIT_SCOPES,
  UNLIMITED_ROUTES,
  rateLimitFor,
} from './rate-limit.js';

describe('the limits table', () => {
  it('matches docs/03 §2 exactly', () => {
    expect(RATE_LIMITS.staff_api).toMatchObject({ max: 600, timeWindow: '1 minute' });
    expect(RATE_LIMITS.candidate_autosave).toMatchObject({ max: 60, timeWindow: '1 minute' });
    expect(RATE_LIMITS.trial_run).toMatchObject({ max: 60, timeWindow: '1 hour' });
    expect(RATE_LIMITS.token_redemption).toMatchObject({ max: 20, timeWindow: '1 hour' });
  });

  it('keeps the submission cap out of the windowed limits', () => {
    // "10 total" is a lifetime cap, not a window. A window resets — on the hour, on a
    // deploy, on a reschedule — and a reset window lets an eleventh submission through
    // for a question the candidate was told they had ten attempts at.
    expect(RATE_LIMIT_SCOPES).toContain('submission');
    expect(Object.keys(RATE_LIMITS)).not.toContain('submission');
    expect(MAX_SUBMISSIONS_PER_ATTEMPT_QUESTION).toBe(10);
  });

  it('builds a route configuration carrying both the window and its scope', () => {
    expect(rateLimitFor('candidate_autosave')).toEqual({
      rateLimit: { max: 60, timeWindow: '1 minute' },
      rateLimitScope: 'candidate_autosave',
    });
  });

  it('exempts every route infrastructure polls on a fixed interval', () => {
    expect([...UNLIMITED_ROUTES].sort()).toEqual([
      '/healthz',
      '/metrics',
      '/openapi.json',
      '/readyz',
    ]);
  });
});
