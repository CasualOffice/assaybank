/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Domain failure codes. A closed union: adding one is a deliberate edit, exactly as
 * with the API `ErrorCode` enum (docs/03 §2). Callers branch on `code`; `message` is
 * for humans and may change freely.
 */
export type DomainErrorCode =
  /** The event is not defined for this state (docs/03 §8). */
  | 'illegal_transition'
  /** `void` carried an empty reason. Voiding is audited, so the reason is mandatory. */
  | 'void_reason_required'
  /** The attempt is already voided; there is nothing left to void. */
  | 'already_voided'
  /** The rule itself is malformed — a non-positive pick count, an inverted range. */
  | 'invalid_rule'
  /** The pool cannot satisfy `pickCount` under the rule's filters (ADR-004). */
  | 'draw_infeasible';

/**
 * A domain failure. `details` carries structured context for the API `details` field —
 * counts and states only. It never carries question content, answer keys or candidate
 * identifiers, because an error envelope is a place leaks hide (docs/14).
 */
export type DomainError = {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * Builds a `DomainError`. `details` is omitted rather than set to `undefined` so the
 * shape satisfies `exactOptionalPropertyTypes` and serialises without a null field.
 */
export function domainError(
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details };
}
