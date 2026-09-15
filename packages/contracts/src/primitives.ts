/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared request and response primitives from docs/03-API-spec.md §2.
 *
 * Every convention in that section is expressed once, here, so that two endpoints
 * written six weeks apart cannot paginate differently or disagree about what a
 * timestamp looks like. Nothing in this module performs I/O or reads a clock.
 */

import './openapi-extension.js';

import { z } from 'zod';

/**
 * A UUID as defined by RFC 9562 (which obsoletes RFC 4122), in the canonical
 * 8-4-4-4-12 lower- or upper-case hexadecimal form.
 *
 * docs/03-API-spec.md §2 says identifiers are UUIDv4, and `gen_random_uuid()` produces
 * v4. The schema deliberately accepts any version rather than v4 alone: the database is
 * the only issuer of identifiers, a future migration to v7 for insert locality is a
 * plausible change that must not require a contract change, and an identifier arriving
 * from a client is looked up before it is trusted regardless of which version bits it
 * carries. The nil and max UUIDs are accepted by the same rule.
 */
export const UuidSchema = z.uuid().describe('An RFC 9562 UUID in canonical 8-4-4-4-12 form.');

/** A UUID string that has been parsed, but carries no identity brand of its own. */
export type Uuid = z.infer<typeof UuidSchema>;

/**
 * An RFC 3339 timestamp in UTC — the only timestamp format this API speaks, in either
 * direction (docs/03-API-spec.md §2, docs/17 §4 "`timestamptz` always").
 *
 * The trailing `Z` is required. An offset such as `+02:00` is rejected rather than
 * normalised, because a deadline that survives a round trip through a client's local
 * timezone is exactly the class of bug ADR-006 exists to prevent.
 */
export const Rfc3339Schema = z.iso
  .datetime()
  .describe('An RFC 3339 timestamp in UTC, e.g. 2026-09-14T10:30:00Z.');

/** An RFC 3339 UTC timestamp string. */
export type Rfc3339 = z.infer<typeof Rfc3339Schema>;

/** The largest cursor this API will accept or emit, in characters. */
const CURSOR_MAX_LENGTH = 1024;

/**
 * An opaque pagination cursor.
 *
 * Opaque is the contract: a client stores it and hands it back, and may not parse it.
 * The character class is restricted to URL-safe characters so the value survives a
 * query string without escaping, and the length is bounded so an attacker cannot make
 * the server allocate by sending a megabyte of cursor.
 */
export const CursorSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9._~=-]{1,${CURSOR_MAX_LENGTH}}$`),
    'A cursor is an opaque URL-safe token of at most 1024 characters.',
  )
  .describe('An opaque cursor returned by a previous page. Clients must not parse it.');

/** An opaque pagination cursor. */
export type Cursor = z.infer<typeof CursorSchema>;

/** The page size used when a list request does not ask for one. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The largest page any list endpoint will serve. docs/17 §10: pagination is mandatory
 * on every collection and no endpoint returns an unbounded set.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * The query string of every list endpoint: `?limit=50&cursor=...`.
 *
 * `limit` is coerced because query parameters arrive as strings, and it is bounded on
 * both sides so a client cannot ask for the whole table. Cursor pagination rather than
 * offset pagination, because this system inserts constantly during an exam window and
 * offsets shift underneath a reader (docs/17 §3).
 */
export const PaginationQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Page size, 1 to ${MAX_PAGE_SIZE}. Defaults to ${DEFAULT_PAGE_SIZE}.`),
    cursor: CursorSchema.optional(),
  })
  .describe('Cursor pagination parameters shared by every list endpoint.')
  .openapi('PaginationQuery');

/** The parsed form of a list endpoint's query string. */
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * The response envelope of every list endpoint.
 *
 * `next_cursor` is `null` on the last page rather than absent, so a client's loop
 * condition is a value check and never a property-existence check.
 */
export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Wraps an item schema in the cursor-pagination envelope: `{ data[], next_cursor }`.
 *
 * Every collection response in the API is built with this function, which is what makes
 * "cursor pagination everywhere" a property of the code rather than a rule people
 * remember.
 */
export function paginated<T>(item: z.ZodType<T>) {
  return z.object({
    data: z.array(item).describe('This page of results, in the endpoint’s stated order.'),
    next_cursor: CursorSchema.nullable().describe(
      'Cursor for the next page, or null when this is the last page.',
    ),
  });
}
