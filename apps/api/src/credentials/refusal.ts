/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a candidate credential was refused — recorded on the server, never told to the
 * holder.
 *
 * docs/14-threat-model.md `T-011` is the requirement, and `H-146` states it as a
 * sentence: *"candidate-facing error responses for redeem and join are uniform —
 * `not_found` for expired, revoked, consumed and non-existent alike — so the endpoint is
 * not an oracle."* An attacker scripting `POST /candidate/redeem` against generated
 * tokens learns nothing from the response, because every refusal produces byte-identical
 * output: same status, same code, same message, no `details`.
 *
 * The distinction still exists — it is just kept where it is useful rather than where it
 * is dangerous. A {@link Refusal} carries the reason into the log line under the
 * request's trace id, and into a metric label from a closed set, which is what makes
 * docs/12 §"Invitation redemption failures" alertable at all. The two audiences get
 * different amounts of truth, on purpose.
 *
 * **Why `not_found` and not `401` on redemption.** A 401 invites the client to retry
 * with a credential, and the whole point here is that the presented credential is the
 * only one there will ever be. More importantly, a distinguishable status on redemption
 * is itself the oracle: `401` for "that token exists but is spent" against `404` for
 * "no such token" is precisely the bit the attacker is enumerating for. Bearer-token
 * verification on a candidate route *does* answer `401`, because there the credential is
 * a header a client can be asked to refresh and the resource is not being confirmed or
 * denied.
 */

import type { AuthErrorReason } from '@assaybank/auth';
import { ApiError } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

/** The credential surfaces that can refuse a request. Closed set: it is a metric label. */
export const REFUSAL_SURFACES = ['redeem', 'attempt_token', 'ws_ticket'] as const;

/** One of {@link REFUSAL_SURFACES}. */
export type RefusalSurface = (typeof REFUSAL_SURFACES)[number];

/**
 * Every reason a candidate credential is refused.
 *
 * The first seven mirror `AuthErrorReason` from `@assaybank/auth`, so a refusal that
 * originated in the token verifier keeps its reason on the way through this layer
 * instead of collapsing into "invalid". The rest are this layer's own: they describe the
 * *state* a structurally valid credential ran into, which the pure verifier cannot know.
 */
export const REFUSAL_REASONS = [
  // Mirrored from packages/auth's AuthErrorReason.
  'malformed',
  'signature_invalid',
  'claims_invalid',
  'expired',
  'not_yet_valid',
  'wrong_purpose',
  'attempt_mismatch',
  // This layer's own.
  /** No credential was presented at all: no Authorization header, no token in the body. */
  'absent',
  /** No invitation carries the presented token's hash. */
  'no_such_invitation',
  /** An invitation was found by hash but failed the constant-time confirmation. */
  'hash_mismatch',
  /** `opens_at` is in the future: the assessment window has not started. */
  'not_yet_open',
  /** Every sitting the invitation granted has been taken (`max_attempts`). */
  'already_redeemed',
  /** The invitation points at an assessment that is not published. */
  'assessment_not_published',
  /** The invitation has no application, so there is no candidate to create an attempt for. */
  'invitation_incomplete',
  /** A single-use credential was presented a second time. */
  'replayed',
  /** The principal is real but is not the kind this route serves. */
  'wrong_principal',
  /** The session does not exist in this tenant — or exists in another one (`H-154`). */
  'no_such_session',
  /** The interview is over; a ticket would admit the holder to nothing. */
  'session_ended',
] as const;

/** One of {@link REFUSAL_REASONS}. */
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Every `AuthErrorReason` mapped to the refusal reason it becomes.
 *
 * `Record<AuthErrorReason, RefusalReason>` rather than a cast or a lookup with a default:
 * a reason added to `packages/auth` becomes a compile error here, which is the only thing
 * that keeps the two lists in step. The values are identical strings today — that is a
 * property of the two lists, not an assumption any caller may make.
 */
export const REASON_FROM_AUTH: Readonly<Record<AuthErrorReason, RefusalReason>> = Object.freeze({
  malformed: 'malformed',
  signature_invalid: 'signature_invalid',
  claims_invalid: 'claims_invalid',
  expired: 'expired',
  not_yet_valid: 'not_yet_valid',
  wrong_purpose: 'wrong_purpose',
  attempt_mismatch: 'attempt_mismatch',
});

/**
 * docs/12 §608 wants "redemption failures per IP approaching the 20/hour limit" to be
 * alertable, and an operator to be able to tell a spike of `no_such_invitation` (someone
 * is enumerating) from a spike of `already_redeemed` (a client is retrying a success) or
 * of `expired` (a mail campaign went out too late). Both labels are closed sets, so the
 * cardinality guard in `@assaybank/observability` has something finite to enforce.
 */
export const candidateCredentialRefusedTotal: CounterMetric<'surface' | 'reason'> = counter<
  'surface' | 'reason'
>({
  name: 'candidate_credential_refused_total',
  help: 'Candidate credentials refused, by surface and by the reason kept on the server.',
  labelNames: ['surface', 'reason'],
  labelValues: { surface: REFUSAL_SURFACES, reason: REFUSAL_REASONS },
});

/** A refused credential: the reason, the surface, and whatever is safe to log with it. */
export interface Refusal {
  readonly surface: RefusalSurface;
  readonly reason: RefusalReason;
  /**
   * Extra fields for the log line. Identifiers and counts only — never the presented
   * credential, never a hash of it, and never anything that reaches a response body.
   */
  readonly fields: Readonly<Record<string, string | number>>;
}

/** Builds a {@link Refusal}. */
export function refuse(
  surface: RefusalSurface,
  reason: RefusalReason,
  fields: Readonly<Record<string, string | number>> = {},
): Refusal {
  return { surface, reason, fields };
}

/**
 * The status a refusal is served with.
 *
 * Redemption is uniformly `not_found` (`H-146`). A ticket request that names a session
 * the caller cannot see is also `not_found` rather than `forbidden`, because a 403 there
 * would confirm that the session exists in somebody else's organisation (`H-154`,
 * ADR-010). Everything else is `unauthenticated`: the credential in the header was not
 * good enough, and saying so tells the holder nothing they did not already know.
 */
export function errorCodeFor(refusal: Refusal): 'not_found' | 'unauthenticated' {
  if (refusal.surface === 'redeem') return 'not_found';
  if (refusal.reason === 'no_such_session' || refusal.reason === 'session_ended') {
    return 'not_found';
  }
  return 'unauthenticated';
}

/**
 * The error a refusal is served as: the standard envelope, the default message for the
 * code, and **no `details`**. Two refusals of the same surface are indistinguishable.
 */
export function toApiError(refusal: Refusal): ApiError {
  return errorCodeFor(refusal) === 'not_found' ? ApiError.notFound() : ApiError.unauthenticated();
}

/**
 * The one method of a logger this module needs.
 *
 * Structural rather than `pino.Logger` or `FastifyBaseLogger`: both satisfy it, a test
 * double is two lines, and naming either of them here would make this module depend on
 * the HTTP framework for the sake of one call.
 */
export interface RefusalLog {
  warn(payload: Record<string, unknown>, message: string): void;
}

/**
 * Records the refusal where it is useful: one counter increment and one `warn` line
 * carrying the reason, the surface and the caller's fields, under the request's trace id.
 *
 * `warn`, not `error`: a refused token is the system working. It becomes interesting in
 * aggregate, which is what the counter is for.
 */
export function recordRefusal(log: RefusalLog, refusal: Refusal): void {
  candidateCredentialRefusedTotal.inc({ surface: refusal.surface, reason: refusal.reason });
  log.warn(
    {
      event: 'candidate.credential_refused',
      surface: refusal.surface,
      reason: refusal.reason,
      ...refusal.fields,
    },
    'candidate credential refused',
  );
}
