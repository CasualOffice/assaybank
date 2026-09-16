/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The three properties `keys.ts` claims, asserted rather than argued.
 *
 * The one that matters operationally is the last: a credential signed for one surface
 * must not verify on another. The envelope prefix in `packages/auth` already makes that
 * true, and separate keys make it true a second time — two independent mechanisms,
 * because a cross-protocol replay is the kind of bug that survives exactly one of them
 * being refactored away.
 */

import { issueAttemptToken, verifyAttemptToken, fixedClock } from '@assaybank/auth';
import { AttemptIdSchema, OrgIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_PURPOSES, deriveCredentialKey, deriveCredentialKeys } from './keys.js';

const SECRETS = {
  sessionSecret: 'a-local-development-session-secret-of-adequate-length',
  tokenPepper: 'a-local-development-token-pepper-of-adequate-length',
};

describe('deriveCredentialKeys', () => {
  it('gives every surface a different key', () => {
    const keys = deriveCredentialKeys(SECRETS);

    expect(keys.attemptToken).not.toEqual(keys.wsTicket);
    expect(
      new Set(CREDENTIAL_PURPOSES.map((p) => deriveCredentialKey(SECRETS.sessionSecret, p))).size,
    ).toBe(CREDENTIAL_PURPOSES.length);
  });

  it('never returns the root secret, for any surface', () => {
    const keys = deriveCredentialKeys(SECRETS);

    for (const key of [keys.attemptToken, keys.wsTicket]) {
      expect(key).not.toContain(SECRETS.sessionSecret);
      expect(key).not.toEqual(SECRETS.sessionSecret);
      // 32 bytes of HMAC-SHA-256, hex encoded.
      expect(key).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('passes TOKEN_PEPPER through untouched', () => {
    // Deliberately not derived: it hashes data at rest, and tying every stored invitation
    // hash to SESSION_SECRET would make rotating a signing key a cohort-wide outage.
    expect(deriveCredentialKeys(SECRETS).pepper).toBe(SECRETS.tokenPepper);
  });

  it('is deterministic, so two replicas accept each other’s credentials', () => {
    expect(deriveCredentialKeys(SECRETS)).toEqual(deriveCredentialKeys({ ...SECRETS }));
  });

  it('changes completely when the root secret changes by one character', () => {
    const other = deriveCredentialKeys({ ...SECRETS, sessionSecret: `${SECRETS.sessionSecret}!` });

    expect(other.attemptToken).not.toEqual(deriveCredentialKeys(SECRETS).attemptToken);
  });

  it('is frozen, so a caller cannot repoint a key at run time', () => {
    expect(Object.isFrozen(deriveCredentialKeys(SECRETS))).toBe(true);
  });

  it('makes a token signed for one surface unverifiable with another surface’s key', () => {
    const keys = deriveCredentialKeys(SECRETS);
    const clock = fixedClock(new Date('2026-09-21T09:00:00.000Z'));

    const token = issueAttemptToken(
      {
        attemptId: AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        orgId: OrgIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        expiresAt: new Date('2026-09-21T11:00:00.000Z'),
      },
      keys.attemptToken,
    );

    expect(verifyAttemptToken(token, keys.attemptToken, clock).ok).toBe(true);

    const underTheTicketKey = verifyAttemptToken(token, keys.wsTicket, clock);
    expect(underTheTicketKey.ok).toBe(false);
    if (underTheTicketKey.ok) return;
    expect(underTheTicketKey.error.reason).toBe('signature_invalid');
  });
});
