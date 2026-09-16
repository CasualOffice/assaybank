/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate-facing serialisers for the credential flow.
 *
 * docs/17 §3 states the rule these types exist to obey: *"Every response is produced by
 * an explicit serialiser typed to its audience. Candidate-facing and staff-facing
 * serialisers for the same entity are different types, not the same type with a flag. A
 * boolean parameter deciding whether to include answer keys will eventually be passed
 * wrong; two types cannot be."*
 *
 * So {@link CandidateAssessmentSummary} is not `Assessment` with fields removed. It is a
 * closed type listing the five things a candidate may know before they start: what the
 * assessment is called, how long they have, how many sections there are, whether they can
 * go back, and its identifier. There is no field for the pass mark, for the job opening,
 * for who created it, for the proctoring profile, or for anything about the questions —
 * and because the type has no such field, no future refactor of the row it is built from
 * can put one in a response by accident.
 *
 * `snake_case` keys, because that is the wire convention of docs/03 §2; the domain types
 * either side of this boundary stay `camelCase`. The conversion happens once, here, which
 * is the only place it is allowed to happen.
 *
 * Every response carries `server_time` (docs/03 §7, ADR-006): the candidate's countdown is
 * a rendering of the server's clock, and a client that never sees the server's time has
 * no choice but to trust its own.
 */

import type { SessionId } from '@assaybank/contracts';

import type { Redemption } from './redemption.js';
import type { IssuedWsTicket } from './ws-ticket.js';

/** What a candidate is told about the assessment they are about to sit. */
export interface CandidateAssessmentSummary {
  readonly id: string;
  readonly name: string;
  /** The budget. `deadline_at` is computed from it at start, by the server (ADR-006). */
  readonly duration_seconds: number;
  /** How many sections. A number, never the sections, and never their questions. */
  readonly section_count: number;
  /** Whether returning to an answered question is permitted. */
  readonly allow_back_nav: boolean;
}

/** The body of a successful `POST /candidate/redeem` (docs/03 §1). */
export interface RedeemResponse {
  /** The bearer credential, returned exactly once. */
  readonly attempt_token: string;
  /** When it stops being accepted. RFC 3339, UTC. */
  readonly attempt_token_expires_at: string;
  /** The attempt it is scoped to, and nothing about anybody else's. */
  readonly attempt: {
    readonly id: string;
    /** Which sitting of the invitation this is. `1` for the first. */
    readonly sitting: number;
  };
  readonly assessment_summary: CandidateAssessmentSummary;
  /** The server's clock, which is the only clock that counts (ADR-006). */
  readonly server_time: string;
}

/** Serialises a redemption for the candidate who performed it. */
export function toRedeemResponse(redemption: Redemption, serverTime: Date): RedeemResponse {
  return {
    attempt_token: redemption.attemptToken,
    attempt_token_expires_at: redemption.expiresAt.toISOString(),
    attempt: {
      id: redemption.attemptId,
      sitting: redemption.sitting,
    },
    assessment_summary: {
      id: redemption.assessment.id,
      name: redemption.assessment.name,
      duration_seconds: redemption.assessment.durationSeconds,
      section_count: redemption.assessment.sectionCount,
      allow_back_nav: redemption.assessment.allowBackNav,
    },
    server_time: serverTime.toISOString(),
  };
}

/** The body of a successful `POST /sessions/{id}/ticket` (docs/03 §1 and §10). */
export interface TicketResponse {
  /** The opaque ticket. Goes in the WebSocket URL and nowhere else. */
  readonly ticket: string;
  /** Sixty, from `WS_TICKET_TTL_SECONDS`. The client refreshes rather than guesses. */
  readonly expires_in: number;
  /** Which session it admits the holder to, echoed so a client cannot mismatch them. */
  readonly session_id: string;
  readonly server_time: string;
}

/** Serialises an issued ticket. */
export function toTicketResponse(
  issued: IssuedWsTicket,
  sessionId: SessionId,
  serverTime: Date,
): TicketResponse {
  return {
    ticket: issued.ticket,
    expires_in: issued.expiresIn,
    session_id: sessionId,
    server_time: serverTime.toISOString(),
  };
}
