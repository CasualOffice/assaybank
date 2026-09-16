/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The attempt token's HTTP behaviour: what a header becomes, how long a token lives, and
 * the two refusals this phase exists to prove.
 *
 * Both of those refusals are measured against an **injected clock**. Nothing in this file
 * sleeps and nothing calls `Date.now()`, which is the only way an expiry assertion is
 * both deterministic and about the boundary rather than about a second either side of it
 * (ADR-006, docs/17 §8).
 */

import {
  fixedClock,
  issueWsTicket,
  PERMISSIONS,
  can,
  type CandidatePrincipal,
} from '@assaybank/auth';
import { AttemptIdSchema, OrgIdSchema, SessionIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_TOKEN_START_WINDOW_SECONDS,
  ATTEMPT_TOKEN_TAIL_SECONDS,
  MAX_ATTEMPT_TOKEN_LIFE_SECONDS,
  attemptTokenLifeSeconds,
  authenticateAttempt,
  bearerCredential,
  mintAttemptToken,
} from './attempt-token.js';
import { deriveCredentialKeys } from './keys.js';

const KEYS = deriveCredentialKeys({
  sessionSecret: 'a-session-secret-for-the-attempt-token-tests',
  tokenPepper: 'a-token-pepper-for-the-attempt-token-tests',
});

const ATTEMPT = AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111');
const OTHER_ATTEMPT = AttemptIdSchema.parse('22222222-2222-4222-8222-222222222222');
const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');

const NOW = new Date('2026-10-12T09:00:00.000Z');
const HOUR_SECONDS = 3600;

/** A token for `ATTEMPT`, minted at {@link NOW} for a one-hour assessment. */
function mint(): { token: string; expiresAt: Date } {
  return mintAttemptToken(
    { attemptId: ATTEMPT, orgId: ORG, durationSeconds: HOUR_SECONDS },
    KEYS.attemptToken,
    fixedClock(NOW),
  );
}

describe('bearerCredential', () => {
  it('reads the credential out of a Bearer header', () => {
    expect(bearerCredential('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts the scheme in any casing, as RFC 7235 requires', () => {
    expect(bearerCredential('bearer abc')).toBe('abc');
    expect(bearerCredential('BEARER abc')).toBe('abc');
  });

  it('refuses every other shape rather than guessing', () => {
    for (const header of ['', 'abc', 'Basic abc', 'Bearer', 'Bearer   ', undefined, ['Bearer a']]) {
      expect(bearerCredential(header)).toBeUndefined();
    }
  });
});

describe('attemptTokenLifeSeconds', () => {
  it('covers the start window, the sitting and the tail', () => {
    expect(attemptTokenLifeSeconds(HOUR_SECONDS)).toBe(
      ATTEMPT_TOKEN_START_WINDOW_SECONDS + HOUR_SECONDS + ATTEMPT_TOKEN_TAIL_SECONDS,
    );
  });

  it('is bounded however long the assessment claims to be', () => {
    // A misconfigured 48-hour duration must not mint a credential that outlives the week.
    expect(attemptTokenLifeSeconds(48 * HOUR_SECONDS)).toBe(MAX_ATTEMPT_TOKEN_LIFE_SECONDS);
  });

  it('tolerates a nonsensical duration without producing a nonsensical life', () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const life = attemptTokenLifeSeconds(duration);
      expect(life).toBeGreaterThan(0);
      expect(life).toBeLessThanOrEqual(MAX_ATTEMPT_TOKEN_LIFE_SECONDS);
    }
  });
});

describe('authenticateAttempt', () => {
  it('turns a valid bearer token into a candidate principal scoped to one attempt', () => {
    const { token } = mint();

    const result = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toEqual<CandidatePrincipal>({
      kind: 'candidate',
      attemptId: ATTEMPT,
      orgId: ORG,
    });
  });

  it('produces a principal that holds no permission, present or future', () => {
    const { token } = mint();
    const result = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The whole staff catalogue, plus keys nobody has defined yet.
    for (const permission of [...PERMISSIONS, 'question.delete', 'org.billing', '*']) {
      expect(can(result.principal, permission)).toBe(false);
    }
  });

  it('refuses a request that presents no credential at all', () => {
    const result = authenticateAttempt(undefined, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ surface: 'attempt_token', reason: 'absent' });
  });

  it('rejects a token presented for a DIFFERENT attempt id', () => {
    // docs/14 T-014 in its candidate form: a genuine token of the holder's own, presented
    // against somebody else's identifier. The refusal happens in the verifier, before any
    // row is read, so the database is never asked about the other attempt at all.
    const { token } = mint();

    const result = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
      expectedAttemptId: OTHER_ATTEMPT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('attempt_mismatch');
  });

  it('accepts the same token for the attempt it was actually minted for', () => {
    const { token } = mint();

    const result = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
      expectedAttemptId: ATTEMPT,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects an expired token against the injected clock, on the instant it expires', () => {
    const { token, expiresAt } = mint();

    const oneMillisecondBefore = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(new Date(expiresAt.getTime() - 1)),
    });
    expect(oneMillisecondBefore.ok).toBe(true);

    // Exactly on the boundary: a token whose expiry instant has arrived is spent.
    const exactlyAt = authenticateAttempt(`Bearer ${token}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(expiresAt),
    });
    expect(exactlyAt.ok).toBe(false);
    if (exactlyAt.ok) return;
    expect(exactlyAt.refusal.reason).toBe('expired');
  });

  it('rejects a token signed with another deployment’s secret', () => {
    const { token } = mint();
    const elsewhere = deriveCredentialKeys({
      sessionSecret: 'some-other-deployments-session-secret',
      tokenPepper: 'irrelevant',
    });

    const result = authenticateAttempt(`Bearer ${token}`, {
      signingKey: elsewhere.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('signature_invalid');
  });

  it('rejects a WebSocket ticket presented as an attempt token', () => {
    // Cross-protocol replay: the two credentials are different secrets *and* different
    // purpose tags, so this fails on the tag before anything is parsed.
    const ticket = issueWsTicket(SESSION, KEYS.wsTicket, fixedClock(NOW));

    const result = authenticateAttempt(`Bearer ${ticket}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('wrong_purpose');
  });

  it('rejects a tampered token', () => {
    const { token } = mint();
    const parts = token.split('.');
    const payload = parts[1] ?? '';
    const tampered = `${parts[0] ?? ''}.${payload.slice(0, -1)}X.${parts[2] ?? ''}`;

    const result = authenticateAttempt(`Bearer ${tampered}`, {
      signingKey: KEYS.attemptToken,
      clock: fixedClock(NOW),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('signature_invalid');
  });
});
