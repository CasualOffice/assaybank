/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The primitives every credential in this package is built from: one keyed hash, one
 * comparison, one encoding. Nothing here knows what a token *means*.
 *
 * The comparison is the part that matters. `a === b` on a digest leaks, through timing,
 * how many leading bytes the attacker guessed correctly, which turns a 2^256 search into
 * a few thousand requests done one byte at a time. Every comparison of a secret in this
 * package goes through {@link constantTimeEquals}, and no secret is ever compared with
 * `===`, `startsWith` or `Buffer.compare`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA-256 of `message` under `key`, hex encoded.
 *
 * HMAC rather than a bare `sha256(key + message)`: the latter is length-extendable, and
 * a hash whose inputs are attacker-influenced strings that get concatenated is exactly
 * where that bites.
 */
export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * Compares two strings in time that does not depend on where they first differ.
 *
 * `node:crypto`'s `timingSafeEqual` requires equal-length buffers and throws otherwise,
 * so unequal lengths are handled by comparing the right-hand side against itself — the
 * work done, and therefore the time taken, depends only on `b`, never on `a`. The
 * result is then forced to `false`. Returning early on a length mismatch would leak the
 * length of the expected digest, which is public here, but the habit of returning early
 * from a secret comparison is the one worth not having.
 *
 * Note the ordering: `timingSafeEqual` is always evaluated, before `sameLength` is
 * consulted, so the `&&` cannot short-circuit the comparison away.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const sameLength = left.length === right.length;
  const comparable = sameLength ? left : right;

  return timingSafeEqual(comparable, right) && sameLength;
}

/** UTF-8 text as unpadded base64url — safe in a URL, a header and a WebSocket query. */
export function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * The inverse of {@link encodeBase64Url}. Never throws: undecodable input yields
 * whatever `Buffer` makes of it, and the caller's parse rejects it a line later.
 */
export function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}
