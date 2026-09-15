/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The signed envelope both stateless credentials in this package are carried in.
 *
 * Wire form, three dot-separated parts:
 *
 * ```
 * <prefix>.<base64url(JSON claims)>.<hex HMAC-SHA-256 over "<prefix>.<payload>">
 * ```
 *
 * Three properties are deliberate.
 *
 * **The prefix is inside the signature.** An attempt token and a WebSocket ticket are
 * signed with different secrets today, but a deployment that misconfigures them to the
 * same value must still not let one be presented as the other. Covering the purpose tag
 * makes cross-protocol replay a signature failure rather than a claims failure, which
 * means it is caught before anything untrusted is parsed.
 *
 * **Nothing is parsed before the signature verifies.** {@link openEnvelope} authenticates
 * first and hands back `unknown` second; the caller then parses with zod. A JSON parser
 * fed attacker-controlled bytes is a small attack surface, but it is one that costs
 * nothing to put behind the MAC.
 *
 * **These are not JWTs.** No `alg` header, so there is no `alg: none` and no algorithm
 * confusion; one algorithm, chosen here, not negotiated by the token. The format is also
 * not self-describing on purpose — an opaque credential invites fewer clients to read
 * claims out of it and start depending on them.
 */

import { constantTimeEquals, decodeBase64Url, encodeBase64Url, hmacHex } from './crypto.js';
import { AuthError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * The longest credential this package will look at.
 *
 * A bearer string arrives from the network in a header or a query parameter. Hashing a
 * megabyte of it before deciding it was nonsense is free work an unauthenticated caller
 * gets to ask for, so the length check happens before the HMAC.
 */
export const MAX_CREDENTIAL_LENGTH = 4096;

/** Domain separation for the envelope MAC. See {@link hmacHex}. */
const ENVELOPE_DOMAIN = 'assaybank.envelope.v1';

/** The number of dot-separated parts in a well-formed envelope. */
const PART_COUNT = 3;

/** The signed string: purpose and payload together, never the payload alone. */
function signedMessage(prefix: string, payload: string): string {
  return `${ENVELOPE_DOMAIN}.${prefix}.${payload}`;
}

/** Serialises `claims`, signs them under `secret`, and returns the wire string. */
export function sealEnvelope(
  prefix: string,
  claims: Record<string, unknown>,
  secret: string,
): string {
  const payload = encodeBase64Url(JSON.stringify(claims));
  return `${prefix}.${payload}.${hmacHex(secret, signedMessage(prefix, payload))}`;
}

/**
 * Authenticates a wire string and returns its claims, still `unknown`.
 *
 * The caller parses. This function's whole job is to decide whether the bytes are worth
 * looking at, and it decides that with a constant-time MAC comparison.
 */
export function openEnvelope(
  credential: string,
  prefix: string,
  secret: string,
): Result<unknown, AuthError> {
  if (credential.length === 0 || credential.length > MAX_CREDENTIAL_LENGTH) {
    return err(new AuthError('malformed'));
  }

  const parts = credential.split('.');
  const [presentedPrefix, payload, signature] = parts;

  if (
    parts.length !== PART_COUNT ||
    presentedPrefix === undefined ||
    payload === undefined ||
    signature === undefined ||
    payload.length === 0
  ) {
    return err(new AuthError('malformed'));
  }

  // The prefix is public routing information, not a secret, so a plain comparison is
  // correct here — and it is covered by the MAC below regardless.
  if (presentedPrefix !== prefix) {
    return err(new AuthError('wrong_purpose'));
  }

  if (!constantTimeEquals(hmacHex(secret, signedMessage(prefix, payload)), signature)) {
    return err(new AuthError('signature_invalid'));
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(payload));
  } catch {
    // Authenticated but unparseable: a key mismatch across a rotation, or our own bug.
    // Either way the holder learns nothing beyond "refused".
    return err(new AuthError('claims_invalid'));
  }

  return ok(claims);
}
