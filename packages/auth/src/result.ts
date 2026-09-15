/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The result type the token verifiers return.
 *
 * Verification failure is an expected outcome, not an exception: every request from a
 * candidate's browser carries a token that might be expired, truncated by a copy-paste,
 * or forged. Returning a value rather than throwing makes the failure path visible in
 * the type, so a caller cannot forget that a token can be bad — it has to read `ok`
 * before it can reach `value`.
 *
 * Throwing is reserved for {@link AuthError} escaping through `ApiError`, which is what
 * a route does *after* it has decided the request is over.
 */

/** Either a value or an error, never both. Narrow on `ok` to reach one of them. */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** The successful branch of a {@link Result}. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** The failed branch of a {@link Result}. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
