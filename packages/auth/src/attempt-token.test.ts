/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AttemptIdSchema, OrgIdSchema, SessionIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_TOKEN_PREFIX,
  type AttemptTokenClaims,
  issueAttemptToken,
  verifyAttemptToken,
} from './attempt-token.js';
import { fixedClock } from './clock.js';
import { MAX_CREDENTIAL_LENGTH, sealEnvelope } from './envelope.js';
import type { AuthError } from './errors.js';
import type { Result } from './result.js';
import { issueWsTicket } from './ws-ticket.js';

const SECRET = 'a-local-development-session-secret';
const OTHER_SECRET = 'some-other-deployments-session-secret';

const ATTEMPT = AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111');
const OTHER_ATTEMPT = AttemptIdSchema.parse('22222222-2222-4222-8222-222222222222');
const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');

const ISSUED_AT = new Date('2026-09-21T09:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-21T11:00:00.000Z');

const CLAIMS: AttemptTokenClaims = {
  attemptId: ATTEMPT,
  orgId: ORG,
  expiresAt: EXPIRES_AT,
};

/** Reads the reason out of a result that must have failed. */
function reasonOf(result: Result<unknown, AuthError>): string {
  if (result.ok) {
    throw new Error('expected the credential to be refused, but it verified');
  }
  return result.error.reason;
}

/** The three parts of an envelope, with the indexing checked rather than asserted. */
function partsOf(credential: string): { prefix: string; payload: string; signature: string } {
  const [prefix, payload, signature] = credential.split('.');
  if (prefix === undefined || payload === undefined || signature === undefined) {
    throw new Error(`not a three-part envelope: ${credential}`);
  }
  return { prefix, payload, signature };
}

describe('issueAttemptToken / verifyAttemptToken', () => {
  it('round-trips the claims it was issued with', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);
    const result = verifyAttemptToken(token, SECRET, fixedClock(ISSUED_AT));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attemptId).toBe(ATTEMPT);
    expect(result.value.orgId).toBe(ORG);
    expect(result.value.expiresAt.toISOString()).toBe(EXPIRES_AT.toISOString());
  });

  it('carries its purpose in the clear so a log line can tell the credentials apart', () => {
    expect(partsOf(issueAttemptToken(CLAIMS, SECRET)).prefix).toBe(ATTEMPT_TOKEN_PREFIX);
  });

  it('does not contain the signing secret', () => {
    expect(issueAttemptToken(CLAIMS, SECRET)).not.toContain(SECRET);
  });
});

describe('an attempt token is scoped to exactly one attempt', () => {
  it('is refused when presented for a different attempt', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);

    const wrongAttempt = verifyAttemptToken(token, SECRET, fixedClock(ISSUED_AT), OTHER_ATTEMPT);

    expect(reasonOf(wrongAttempt)).toBe('attempt_mismatch');
  });

  it('is accepted for its own attempt', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);

    expect(verifyAttemptToken(token, SECRET, fixedClock(ISSUED_AT), ATTEMPT).ok).toBe(true);
  });

  it('names its one attempt even when the caller passes no expectation', () => {
    // A route that omits the expectation must still compare before it touches a row
    // (H-154), and it can only do that because the id is in the claims.
    const result = verifyAttemptToken(
      issueAttemptToken(CLAIMS, SECRET),
      SECRET,
      fixedClock(ISSUED_AT),
    );

    expect(result.ok && result.value.attemptId).toBe(ATTEMPT);
    expect(result.ok && result.value.attemptId === OTHER_ATTEMPT).toBe(false);
  });

  it('cannot have its attempt id swapped, because the id is inside the signature', () => {
    const mine = partsOf(issueAttemptToken(CLAIMS, SECRET));
    const theirs = partsOf(issueAttemptToken({ ...CLAIMS, attemptId: OTHER_ATTEMPT }, SECRET));

    // Splice their payload onto my signature: the obvious forgery to try.
    const spliced = `${ATTEMPT_TOKEN_PREFIX}.${theirs.payload}.${mine.signature}`;

    expect(reasonOf(verifyAttemptToken(spliced, SECRET, fixedClock(ISSUED_AT)))).toBe(
      'signature_invalid',
    );
  });

  it('gives the two attempts two entirely different tokens', () => {
    const mine = issueAttemptToken(CLAIMS, SECRET);
    const theirs = issueAttemptToken({ ...CLAIMS, attemptId: OTHER_ATTEMPT }, SECRET);

    expect(mine).not.toBe(theirs);
    expect(partsOf(mine).signature).not.toBe(partsOf(theirs).signature);
  });
});

describe('expiry is measured against the injected clock', () => {
  it('accepts a token a millisecond before it expires', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);
    const clock = fixedClock(new Date(EXPIRES_AT.getTime() - 1));

    expect(verifyAttemptToken(token, SECRET, clock).ok).toBe(true);
  });

  it('refuses a token at the exact instant it expires', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);

    expect(reasonOf(verifyAttemptToken(token, SECRET, fixedClock(EXPIRES_AT)))).toBe('expired');
  });

  it('refuses a token after it expires', () => {
    const token = issueAttemptToken(CLAIMS, SECRET);
    const clock = fixedClock(new Date(EXPIRES_AT.getTime() + 60_000));

    expect(reasonOf(verifyAttemptToken(token, SECRET, clock))).toBe('expired');
  });

  it('ignores the wall clock entirely', () => {
    // The whole point of injection (ADR-006): the verifier has no opinion about *now*
    // beyond what it was handed, so neither this machine's clock nor a candidate's can
    // move a deadline. A `Date.now()` in the verifier would fail this case for as long
    // as today is not 2026-09-21.
    const token = issueAttemptToken(CLAIMS, SECRET);

    expect(verifyAttemptToken(token, SECRET, fixedClock(ISSUED_AT)).ok).toBe(true);
    expect(reasonOf(verifyAttemptToken(token, SECRET, fixedClock(new Date('2099-01-01'))))).toBe(
      'expired',
    );
  });
});

describe('a forged, foreign or malformed token is refused', () => {
  const clock = fixedClock(ISSUED_AT);

  it('refuses a token signed with a different secret', () => {
    const token = issueAttemptToken(CLAIMS, OTHER_SECRET);

    expect(reasonOf(verifyAttemptToken(token, SECRET, clock))).toBe('signature_invalid');
  });

  it('refuses a token whose payload was edited', () => {
    const original = partsOf(issueAttemptToken(CLAIMS, SECRET));
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, p: 'attempt', aid: OTHER_ATTEMPT, oid: ORG, exp: 4_102_444_800_000 }),
      'utf8',
    ).toString('base64url');

    const forged = `${original.prefix}.${forgedPayload}.${original.signature}`;

    expect(reasonOf(verifyAttemptToken(forged, SECRET, clock))).toBe('signature_invalid');
  });

  it('refuses a WebSocket ticket presented as an attempt token', () => {
    // Same envelope, same secret, different purpose. Cross-protocol replay fails on the
    // purpose tag before a single claim is looked at.
    const ticket = issueWsTicket({ sessionId: SESSION, issuedAt: ISSUED_AT }, SECRET);

    expect(reasonOf(verifyAttemptToken(ticket, SECRET, clock))).toBe('wrong_purpose');
  });

  it.each([
    ['empty', ''],
    ['not an envelope', 'not-a-token'],
    ['two parts only', `${ATTEMPT_TOKEN_PREFIX}.eyJhIjoxfQ`],
    ['four parts', `${ATTEMPT_TOKEN_PREFIX}.eyJhIjoxfQ.abc.def`],
    ['empty payload', `${ATTEMPT_TOKEN_PREFIX}..abc`],
  ])('refuses a %s credential as malformed', (_label, candidate) => {
    expect(reasonOf(verifyAttemptToken(candidate, SECRET, clock))).toBe('malformed');
  });

  it('refuses an oversized credential rather than hashing all of it', () => {
    const huge = `${ATTEMPT_TOKEN_PREFIX}.${'A'.repeat(MAX_CREDENTIAL_LENGTH)}.${'b'.repeat(64)}`;

    expect(huge.length).toBeGreaterThan(MAX_CREDENTIAL_LENGTH);
    expect(reasonOf(verifyAttemptToken(huge, SECRET, clock))).toBe('malformed');
  });

  it('refuses an authentically signed envelope whose claims are the wrong shape', () => {
    // Signed with the real secret, so the signature verifies and the payload parses —
    // and it is still refused, because an attempt id that is not a UUID is not an
    // attempt id. This is the shape a bug on our own side takes.
    const authenticButWrong = sealEnvelope(
      ATTEMPT_TOKEN_PREFIX,
      { v: 1, p: 'attempt', aid: 'not-a-uuid', oid: ORG, exp: EXPIRES_AT.getTime() },
      SECRET,
    );

    expect(reasonOf(verifyAttemptToken(authenticButWrong, SECRET, clock))).toBe('claims_invalid');
  });

  it('refuses an authentically signed envelope that is not JSON at all', () => {
    const notJson = `${ATTEMPT_TOKEN_PREFIX}.${Buffer.from('nonsense', 'utf8').toString('base64url')}`;
    const signed = sealEnvelope(ATTEMPT_TOKEN_PREFIX, { v: 1 }, SECRET);

    // Both refusals are indistinguishable to the holder; only the reason differs, and
    // the reason never leaves the server.
    expect(reasonOf(verifyAttemptToken(notJson, SECRET, clock))).toBe('malformed');
    expect(reasonOf(verifyAttemptToken(signed, SECRET, clock))).toBe('claims_invalid');
  });
});
