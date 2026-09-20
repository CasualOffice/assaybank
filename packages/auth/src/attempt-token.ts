/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate's credential (docs/03-API-spec.md §1, docs/14-threat-model.md T-010).
 *
 * A candidate has no account. They redeem an invitation token once and receive an
 * attempt token, which is presented as `Authorization: Bearer <token>` on every
 * subsequent request. Everything about its shape follows from one sentence in the API
 * specification: *"The attempt token is scoped to exactly one attempt. It cannot read
 * the question bank, other candidates, or any org resource."*
 *
 * **Scope is inside the signature, not alongside it.** The attempt id and the org id are
 * signed claims, so there is no request in which the server has a valid token and does
 * not know which single attempt it authorises. That is why this is built in P0 with no
 * attempt to point at yet: scope can be designed into a credential, but it cannot be
 * retrofitted onto one that has already been issued.
 *
 * **The token is not the authorisation.** It says which attempt is being addressed; the
 * attempt's own state — deadline, submitted, voided — is re-read and re-checked on every
 * request (ADR-006). A token that is cryptographically perfect and three hours stale must
 * still fail a write, and it does, because the deadline lives in the database and not in
 * the claims.
 *
 * **Expiry is measured against an injected clock.** `Date.now()` does not appear in this
 * file. T-011's attacker manipulating a local clock is the obvious reason; the practical
 * one is that an expiry path nobody can test deterministically is an expiry path nobody
 * has tested.
 */

import { type AttemptId, AttemptIdSchema, type OrgId, OrgIdSchema } from '@assaybank/contracts';
import { z } from 'zod';

import type { Clock } from './clock.js';
import { openEnvelope, sealEnvelope } from './envelope.js';
import { AuthError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * The purpose tag, covered by the signature. `abat` is an Assaybank attempt token; `1`
 * is the format version, so a future format can be introduced beside this one rather
 * than instead of it.
 */
export const ATTEMPT_TOKEN_PREFIX = 'abat1';

/** What an attempt token asserts. Exactly one attempt, exactly one org, and an end. */
export type AttemptTokenClaims = {
  /** The single attempt this token authorises. Nothing else is reachable with it. */
  attemptId: AttemptId;
  /** The tenant the attempt belongs to. Becomes `app.current_org` for the request (ADR-010). */
  orgId: OrgId;
  /** When the credential stops being accepted. Server-computed, never client-supplied. */
  expiresAt: Date;
};

/**
 * The on-the-wire claim set. Short keys because this string travels in a header on every
 * autosave; `exp` is epoch milliseconds so the round trip through JSON is exact.
 */
const AttemptClaimsSchema = z.object({
  v: z.literal(1),
  p: z.literal('attempt'),
  aid: AttemptIdSchema,
  oid: OrgIdSchema,
  exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Mints an attempt token for exactly the attempt in `claims`.
 *
 * `expiresAt` is the caller's — which is to say the server's — decision, computed from
 * the server clock and the assessment's duration. Nothing a candidate sends is an input
 * to it.
 */
export function issueAttemptToken(claims: AttemptTokenClaims, secret: string): string {
  return sealEnvelope(
    ATTEMPT_TOKEN_PREFIX,
    {
      v: 1,
      p: 'attempt',
      aid: claims.attemptId,
      oid: claims.orgId,
      exp: claims.expiresAt.getTime(),
    },
    secret,
  );
}

/**
 * Authenticates an attempt token and returns what it authorises.
 *
 * Order matters and is: signature, then claims, then expiry, then scope. Nothing
 * downstream of the signature check runs on unauthenticated bytes, and nothing
 * downstream of the expiry check runs on a dead credential.
 *
 * `expectedAttemptId` is optional and should always be passed on a route that addresses
 * an attempt by id. It closes the gap between "this token is valid" and "this token is
 * valid *for the attempt in this URL*" — T-014's candidate presenting a genuine token of
 * their own against another attempt's `aq_id`. Callers that omit it must compare
 * `claims.attemptId` themselves before touching a row; see
 * docs/14-threat-model.md `H-154`, which requires the comparison to happen inside the
 * query rather than after a fetch.
 */
export function verifyAttemptToken(
  token: string,
  secret: string,
  clock: Clock,
  expectedAttemptId?: AttemptId,
): Result<AttemptTokenClaims, AuthError> {
  const opened = openEnvelope(token, ATTEMPT_TOKEN_PREFIX, secret);
  if (!opened.ok) {
    return err(opened.error);
  }

  const parsed = AttemptClaimsSchema.safeParse(opened.value);
  if (!parsed.success) {
    return err(new AuthError('claims_invalid'));
  }

  const claims: AttemptTokenClaims = {
    attemptId: parsed.data.aid,
    orgId: parsed.data.oid,
    expiresAt: new Date(parsed.data.exp),
  };

  // `>=` rather than `>`: a token whose expiry instant has exactly arrived is spent. The
  // boundary has to fall somewhere, and it falls on the side that refuses.
  if (clock.now().getTime() >= claims.expiresAt.getTime()) {
    return err(new AuthError('expired'));
  }

  if (expectedAttemptId !== undefined && claims.attemptId !== expectedAttemptId) {
    return err(new AuthError('attempt_mismatch'));
  }

  return ok(claims);
}
