/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal `Result` type. Domain failures are values, not exceptions.
 *
 * An illegal attempt transition and an infeasible section rule are *expected* outcomes
 * of a legitimate call — the API turns them into a 409 and a 422 — so they travel back
 * as data that the type system forces the caller to look at. `throw` is reserved for
 * programmer error (a negative duration, a weight array of the wrong length): things a
 * zod parse at the edge should already have rejected, and which no caller can handle.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

/** Either a `value` or an `error`, never both, never neither. */
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** The value, or `fallback` when the result is an error. Never throws. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Applies `fn` to a success value, passing an error through untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
