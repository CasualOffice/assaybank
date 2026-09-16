/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one thing `POST /sessions/{id}/ticket` needs to know about an interview session:
 * does it exist in this tenant, and is it still running.
 *
 * Deliberately not a session repository. A ticket request is a credential request, and
 * the only inputs to that decision are those two facts — so this port cannot return the
 * room code, the document snapshot, the participants or the recording URL, and a future
 * change that wanted one of them would have to say so in the type.
 *
 * **Scoping is `withOrg`, not a `WHERE` clause.** The lookup runs inside the transaction
 * that sets `app.current_org` from the staff principal's organisation, so a session id
 * belonging to another tenant returns no row even though the query names it (ADR-010).
 * The route then answers `not_found` rather than `forbidden`, because a 403 would confirm
 * that somebody else holds that id (docs/14 `H-128`).
 */

import { type OrgId, type SessionId } from '@assaybank/contracts';
import { withOrg, type Database } from '@assaybank/db';
import { sql } from 'drizzle-orm';

import { optionalDate } from './driver-values.js';

/** What the ticket route learns about a session. Two facts, and no content. */
export interface SessionAvailability {
  readonly sessionId: SessionId;
  /** `scheduled` | `live` | `ended`, as the column holds it. */
  readonly status: string;
  /** Set once the interview is over. A ticket then admits the holder to nothing. */
  readonly endedAt: Date | undefined;
}

/** The lookup behind the ticket route. */
export interface SessionGateway {
  /**
   * The session with this id in this organisation, or `undefined` — which covers "no
   * such session" and "somebody else's session" with one answer, on purpose.
   */
  findSession(orgId: OrgId, sessionId: SessionId): Promise<SessionAvailability | undefined>;
}

/** Builds the PostgreSQL implementation. */
export function createPostgresSessionGateway(db: Database): SessionGateway {
  return {
    async findSession(
      orgId: OrgId,
      sessionId: SessionId,
    ): Promise<SessionAvailability | undefined> {
      const rows = await withOrg(db, orgId, async (tx) =>
        // No `WHERE org_id = …`: the scoping is the policy, and a predicate here would
        // hide whether the policy is still there. See the module comment.
        tx.execute<{ status: string; ended_at: unknown }>(sql`
          SELECT status, ended_at
            FROM interview_sessions
           WHERE id = ${sessionId}::uuid
        `),
      );

      const row = rows[0];
      if (row === undefined) return undefined;

      return {
        sessionId,
        status: row.status,
        // Parsed, not assumed: `execute` hands back the RFC 3339 text PostgreSQL sent,
        // not a `Date`, and a string wearing a `Date`'s type fails at the first
        // `.getTime()` rather than here. See `driver-values.ts`.
        endedAt: optionalDate(row.ended_at, 'ended_at'),
      };
    },
  };
}
