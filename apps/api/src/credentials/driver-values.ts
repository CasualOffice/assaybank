/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Narrowing a driver value into a domain value, in the one place that knows how the
 * driver spells things.
 *
 * docs/17 §1: *"Data crossing a boundary — HTTP, queue, database row, environment — is
 * parsed into a domain type once, at the edge."* A row returned by `tx.execute` is that
 * kind of data and it is not what the declaring type claims: postgres.js parses a
 * `timestamptz` into a `Date` for its own tagged-template queries, while the same column
 * read through Drizzle's `execute` arrives as the RFC 3339 **text** PostgreSQL sent. A
 * gateway that assigns `row.ended_at` straight into a field typed `Date` compiles, runs,
 * and hands every downstream caller a string wearing a `Date`'s type — which fails at the
 * first `.getTime()`, in production, months later.
 *
 * So there is exactly one copy of the rule. This module exists because there were two
 * gateways: one parsed, one assumed, and the one that assumed had no test.
 */

/**
 * Narrows a driver value to a `Date`.
 *
 * Throwing produces a 500 and a log line. The alternative — a silent
 * `new Date(undefined)` — produces an `Invalid Date` that compares false against every
 * window and refuses a legitimate candidate for no stated reason, which is the failure
 * this function exists to make impossible.
 */
export function requireDate(value: unknown, column: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new Error(`the ${column} column returned a value that is not an instant`);
}

/** As {@link requireDate}, for a nullable column. `NULL` becomes `undefined`. */
export function optionalDate(value: unknown, column: string): Date | undefined {
  return value === null || value === undefined ? undefined : requireDate(value, column);
}

/**
 * Narrows a driver value to a non-negative integer.
 *
 * `bigint` columns and `count(*)` come back as strings from some drivers and as numbers
 * from others; a sitting allowance that silently became `NaN` would compare false against
 * every bound and admit every redemption.
 */
export function requireCount(value: unknown, column: string): number {
  const numeric = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`the ${column} column returned a value that is not a count`);
  }
  return numeric;
}
