/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyset cursors — the encoding behind `?cursor=` on every list endpoint.
 *
 * docs/03 §2 and docs/17 §3 both require cursor pagination and both give the same
 * reason: *"offset pagination breaks under concurrent insertion, and this system inserts
 * constantly during an exam window."* An `OFFSET 50` page is defined relative to a
 * result set that has changed since the previous page was served, so a row inserted
 * above the window shifts everything down and the reader sees one row twice and one row
 * never. A keyset page is defined relative to the last row the reader actually saw,
 * which does not move.
 *
 * The cursor is **opaque by contract** (`CursorSchema` says clients must not parse it)
 * and the encoding here honours that in the only way that matters: nothing outside this
 * module decodes one, and a cursor that does not decode is treated as absent rather than
 * as an error. It is base64url, not encryption — an opaque token is not a secret token,
 * and a client that peels it open learns a timestamp and a row id it was just served.
 *
 * ## Why the sort key travels as text
 *
 * The obvious encoding is an epoch in milliseconds. It is wrong, and wrong in a way that
 * only shows up under load. `timestamptz` has microsecond resolution and a JavaScript
 * `Date` has millisecond resolution, so a cursor built from a `Date` is the row's
 * timestamp *rounded down*. The next page then asks for rows strictly before that
 * rounded value and silently skips every row whose instant fell in the discarded
 * microseconds — which, during a bulk import that inserts a few hundred rows a second,
 * is a page boundary that quietly loses rows. So the query selects the sort key as
 * `::text`, at full precision, and hands it back to Postgres as a `timestamptz`
 * parameter. The value never passes through a `Date` at all.
 *
 * ## Why the id is part of the key
 *
 * Two questions created in the same transaction share an instant exactly —
 * `now()` is the transaction start time — so a timestamp alone is not unique and a
 * strict comparison on it would skip every row that tied with the cursor row. The row
 * comparison `(created_at, id) < (cursor_at, cursor_id)` breaks the tie deterministically
 * and matches the index this ordering is served by.
 *
 * Nothing here reads a clock or performs I/O.
 */

/** The last row of a page, as the next page's lower bound. */
export interface Keyset {
  /**
   * The sort key, as PostgreSQL rendered it: `2026-10-20 09:00:00.123456+00`. Text at
   * full precision, never a `Date` — see the module comment.
   */
  readonly at: string;
  /** The row's uuid, which breaks a tie on `at`. */
  readonly id: string;
}

/**
 * The separator between the two halves.
 *
 * A vertical bar: it cannot occur in a PostgreSQL timestamp rendering or in a uuid, so
 * the first occurrence is unambiguously the boundary and the decoder needs no escaping
 * rules to get right.
 */
const SEPARATOR = '|';

/** The longest cursor payload that could be legitimate, before encoding. */
const MAX_PAYLOAD_LENGTH = 128;

/** A uuid in canonical form. The decoder checks it, because a cursor is client input. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/**
 * A PostgreSQL `timestamptz` rendering: `2026-10-20 09:00:00.123456+00`.
 *
 * Checked rather than trusted. The decoded value is interpolated into a query as a
 * parameter, so a malformed one could not inject anything — but it *could* abort the
 * transaction with a cast error, which turns a bad cursor into a 500 instead of a 422.
 * A shape check here makes a mangled cursor mean "start from the beginning".
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/u;

/**
 * Encodes a keyset as the opaque token a client hands back.
 *
 * base64url, with padding stripped: the result matches `CursorSchema`'s character class
 * and survives a query string with no escaping.
 */
export function encodeKeysetCursor(keyset: Keyset): string {
  return Buffer.from(`${keyset.at}${SEPARATOR}${keyset.id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or `undefined` when it is not one this build produced.
 *
 * **Total, and never throws.** A cursor is client input: it arrives from a URL somebody
 * pasted, a bookmark from a previous release, or an attacker. Every failure mode —
 * invalid base64, a missing separator, a timestamp that is not one, an id that is not a
 * uuid — collapses to `undefined`, and the caller treats that as "no cursor" and serves
 * the first page.
 *
 * Serving the first page rather than a 422 is the deliberate choice. A stale cursor is
 * the common case, the reader's intent is "give me this list", and an error envelope in
 * response to a bookmark helps nobody. Nothing is lost: the page is still a correct page
 * of the same list.
 */
export function decodeKeysetCursor(cursor: string): Keyset | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  if (decoded.length === 0 || decoded.length > MAX_PAYLOAD_LENGTH) return undefined;

  const boundary = decoded.indexOf(SEPARATOR);
  if (boundary <= 0) return undefined;

  const at = decoded.slice(0, boundary);
  const id = decoded.slice(boundary + SEPARATOR.length);

  if (!TIMESTAMP.test(at) || !UUID.test(id)) return undefined;

  return { at, id };
}
