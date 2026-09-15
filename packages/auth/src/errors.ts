/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a credential was refused — kept on the server, never told to the holder.
 *
 * docs/14-threat-model.md T-011 requires that candidate-facing credential endpoints are
 * not oracles: expired, revoked, consumed, forged and never-existed must be
 * indistinguishable from outside, or an attacker scripting `POST /candidate/redeem`
 * learns which of its guesses were structurally right. So `reason` exists for the log
 * line and the metric label, and {@link AuthError.toApiError} throws away the
 * distinction on the way out — every reason becomes the same `unauthenticated`
 * envelope with the same message and no details.
 */

import { ApiError } from '@assaybank/contracts';

/** The closed set of reasons a token, ticket or signature was refused. */
export const AUTH_ERROR_REASONS = [
  /** The string was not a token of this kind at all: wrong prefix, wrong shape, too long. */
  'malformed',
  /** The signature did not verify under the given secret. Forged, tampered, or wrong key. */
  'signature_invalid',
  /** The signature verified, but the payload is not the claim set this kind carries. */
  'claims_invalid',
  /** The credential's lifetime has ended, measured against the injected clock. */
  'expired',
  /** Issued in the future by more than the tolerated skew — a manipulated or broken clock. */
  'not_yet_valid',
  /** A valid token of the wrong kind: an attempt token presented as a WebSocket ticket. */
  'wrong_purpose',
  /** A valid attempt token, for a different attempt than the one being addressed. */
  'attempt_mismatch',
] as const;

/** One of {@link AUTH_ERROR_REASONS}. */
export type AuthErrorReason = (typeof AUTH_ERROR_REASONS)[number];

/**
 * A refused credential.
 *
 * It is an `Error` so it carries a stack for the log, but it is normally returned inside
 * a {@link Result} rather than thrown: a bad token is an expected request, not an
 * exceptional one.
 */
export class AuthError extends Error {
  override readonly name: string = 'AuthError';

  /** Why it was refused. For the log and the metric — never for the client. */
  readonly reason: AuthErrorReason;

  constructor(reason: AuthErrorReason, message?: string) {
    super(message ?? `The credential was refused: ${reason}.`);
    this.reason = reason;
  }

  /**
   * The error the client is served: `401 unauthenticated`, with the generic message and
   * no `details`, whatever the reason was.
   *
   * Uniform on purpose (T-011). Two reasons that produced two different messages would
   * turn this endpoint into a token oracle, and "expired" versus "no such token" is
   * exactly the bit a brute-force script is trying to learn.
   */
  toApiError(): ApiError {
    return ApiError.unauthenticated(undefined, { cause: this });
  }
}
