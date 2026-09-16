/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The attempt token, as the HTTP surface issues and accepts it.
 *
 * `packages/auth` owns the cryptography — the envelope, the signature, the claim set,
 * the expiry comparison against an injected clock. What lives here is the part that is
 * about *this service*: where the token life comes from, how a header becomes a
 * principal, and what a refusal turns into.
 *
 * ## One attempt, and nothing else
 *
 * docs/03-API-spec.md §1: *"The attempt token is scoped to exactly one attempt. It
 * cannot read the question bank, other candidates, or any org resource."* Two mechanisms
 * hold that up, and they are independent on purpose:
 *
 * 1. The scope is a signed claim, so there is no request in which the server holds a
 *    valid token and does not know which single attempt it authorises. A route that
 *    addresses an attempt passes `expectedAttemptId`, and a token minted for another
 *    attempt is refused by the verifier before any row is read — `T-014`'s candidate
 *    presenting their own genuine token against somebody else's identifier.
 * 2. The principal it produces is a `CandidatePrincipal`, which has no `permissions`
 *    field at all. `can()` returns `false` for it for every permission, including
 *    permissions invented after this file was written, because the candidate branch does
 *    not consult a set — it returns. That is asserted, over the whole `PERMISSIONS`
 *    list, by the standing leak suite.
 *
 * ## The token is not the authorisation
 *
 * It says which attempt is being addressed. Whether that attempt may still be written to
 * — deadline, submitted, voided — is re-read from the database on every request
 * (ADR-006). A cryptographically perfect token against a submitted attempt must still
 * fail, and it does, because the deadline lives in a column and not in the claims. The
 * token's own life is therefore deliberately *longer* than the sitting rather than
 * exactly as long: a candidate whose token expired at the deadline could not read their
 * own "time is up" screen, and an expiry that has to be exactly right is an expiry that
 * scores somebody zero when it is not.
 */

import {
  type CandidatePrincipal,
  type Clock,
  issueAttemptToken,
  verifyAttemptToken,
} from '@assaybank/auth';
import type { AttemptId, OrgId } from '@assaybank/contracts';

import { refuse, REASON_FROM_AUTH, type Refusal, type RefusalSurface } from './refusal.js';

/** The scheme of the `Authorization` header a candidate presents. */
export const BEARER_SCHEME = 'Bearer';

/**
 * How long a candidate has, after redeeming, to actually begin the assessment.
 *
 * The attempt is created at redemption and started by `POST /attempt/start`, and a
 * candidate who redeems on their phone during a commute and starts at a desk an hour
 * later is ordinary behaviour, not an attack. Thirty minutes is generous enough for that
 * and short enough that a token pasted into a group chat is usually already dead.
 */
export const ATTEMPT_TOKEN_START_WINDOW_SECONDS = 30 * 60;

/**
 * How long the token outlives the deadline.
 *
 * The candidate still has to be able to submit the request that lands on the deadline,
 * read the confirmation screen, and retry the submit their bad network dropped. Fifteen
 * minutes of tail costs nothing — every one of those requests is re-checked against
 * `attempts.status` and `deadline_at` anyway — and removing it would turn a flaky
 * connection into a lost submission.
 */
export const ATTEMPT_TOKEN_TAIL_SECONDS = 15 * 60;

/**
 * The ceiling on a token's life, whatever the assessment's duration says.
 *
 * An assessment configured with an eight-hour duration must not mint a credential that
 * is still live tomorrow. Twelve hours covers the longest sitting the product allows
 * plus both windows above, and nothing is allowed past it.
 */
export const MAX_ATTEMPT_TOKEN_LIFE_SECONDS = 12 * 60 * 60;

/**
 * The life of a token minted for a sitting of `durationSeconds`.
 *
 * Server-computed from the assessment's configuration and the server's clock. Nothing a
 * candidate sends is an input (ADR-006).
 */
export function attemptTokenLifeSeconds(durationSeconds: number): number {
  const bounded = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  return Math.min(
    ATTEMPT_TOKEN_START_WINDOW_SECONDS + bounded + ATTEMPT_TOKEN_TAIL_SECONDS,
    MAX_ATTEMPT_TOKEN_LIFE_SECONDS,
  );
}

/** A freshly minted attempt token, and the instant it stops being accepted. */
export interface IssuedAttemptToken {
  /** The bearer string. Returned to the candidate once; never stored by this service. */
  readonly token: string;
  /** When it expires, from the injected clock plus {@link attemptTokenLifeSeconds}. */
  readonly expiresAt: Date;
}

/** What {@link mintAttemptToken} needs to know. */
export interface AttemptTokenSubject {
  readonly attemptId: AttemptId;
  readonly orgId: OrgId;
  /** The assessment's `duration_seconds`. Decides the life, not the deadline. */
  readonly durationSeconds: number;
}

/** Mints a token scoped to exactly one attempt. */
export function mintAttemptToken(
  subject: AttemptTokenSubject,
  signingKey: string,
  clock: Clock,
): IssuedAttemptToken {
  const expiresAt = new Date(
    clock.now().getTime() + attemptTokenLifeSeconds(subject.durationSeconds) * 1000,
  );

  return {
    token: issueAttemptToken(
      { attemptId: subject.attemptId, orgId: subject.orgId, expiresAt },
      signingKey,
    ),
    expiresAt,
  };
}

/**
 * Extracts the bearer credential from an `Authorization` header.
 *
 * Case-insensitive on the scheme, because `bearer` is what several HTTP clients send and
 * RFC 7235 says the scheme is case-insensitive. Returns `undefined` for anything else —
 * including `Basic`, including a bare token with no scheme — rather than guessing.
 */
export function bearerCredential(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;

  const separator = header.indexOf(' ');
  if (separator < 0) return undefined;

  const scheme = header.slice(0, separator);
  if (scheme.toLowerCase() !== BEARER_SCHEME.toLowerCase()) return undefined;

  const credential = header.slice(separator + 1).trim();
  return credential.length === 0 ? undefined : credential;
}

/** Either a principal or the reason there is not one. */
export type CandidateAuthentication =
  | { readonly ok: true; readonly principal: CandidatePrincipal }
  | { readonly ok: false; readonly refusal: Refusal };

/** What {@link authenticateAttempt} needs: the key, the clock, and which surface refused. */
export interface AttemptAuthOptions {
  readonly signingKey: string;
  readonly clock: Clock;
  /**
   * The attempt this request addresses, when the route names one.
   *
   * Always pass it where the URL carries an attempt or an attempt-question id. It is
   * what separates "this token is valid" from "this token is valid *for the attempt in
   * this URL*".
   */
  readonly expectedAttemptId?: AttemptId | undefined;
  /** Which surface to label a refusal with. Defaults to `attempt_token`. */
  readonly surface?: RefusalSurface | undefined;
}

/**
 * Turns an `Authorization` header into a {@link CandidatePrincipal}, or into a refusal.
 *
 * Expiry is measured against `options.clock` — `Date.now()` appears nowhere in this file
 * or in the verifier it calls, so "an expired token is rejected" is a deterministic
 * assertion about an injected instant rather than a test that sleeps.
 */
export function authenticateAttempt(
  header: string | string[] | undefined,
  options: AttemptAuthOptions,
): CandidateAuthentication {
  const surface: RefusalSurface = options.surface ?? 'attempt_token';
  const credential = bearerCredential(header);

  if (credential === undefined) {
    return { ok: false, refusal: refuse(surface, 'absent') };
  }

  const verified = verifyAttemptToken(
    credential,
    options.signingKey,
    options.clock,
    options.expectedAttemptId,
  );

  if (!verified.ok) {
    return { ok: false, refusal: refuse(surface, REASON_FROM_AUTH[verified.error.reason]) };
  }

  return {
    ok: true,
    principal: {
      kind: 'candidate',
      attemptId: verified.value.attemptId,
      orgId: verified.value.orgId,
    },
  };
}
