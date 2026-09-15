/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Column primitives shared by every section of the schema.
 *
 * Two PostgreSQL types have no first-class Drizzle builder and are declared here as
 * custom types rather than approximated: `citext`, which is what makes
 * `UNIQUE (org_id, email)` mean what a human means by it, and `bytea`, which carries the
 * final Yjs snapshot of an interview document.
 *
 * `tstz()` exists so that a naive `timestamp` cannot be written by accident. docs/17 §4:
 * "timestamptz always, never naive". A naive timestamp in this system is a deadline that
 * moves when the server's timezone does, and ADR-006 makes the clock a correctness
 * boundary rather than a detail.
 */

import { customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text. Used for `users.email` and `candidates.email` so that the
 * unique constraint on `(org_id, email)` rejects `Ada@example.com` when
 * `ada@example.com` already exists, which is what every caller already assumes.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Raw bytes. `interview_sessions.doc_state` holds a Yjs update, which is a binary
 * CRDT payload and not text: base64 in a `text` column would inflate it by a third and
 * invite someone to try to read it.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * A `timestamptz`. Every point in time in this schema is one of these.
 *
 * `mode: 'date'` maps to a JavaScript `Date`, which is an absolute instant — the value
 * that survives a server moving between regions. Formatting for a human is the
 * presentation layer's problem and happens in the viewer's locale (docs/08).
 */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
