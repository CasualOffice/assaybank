/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebSocket tickets: minted here, spent once, dead in sixty seconds.
 *
 * A browser cannot set an `Authorization` header on a WebSocket handshake, so the
 * credential travels in the URL — where it lands in proxy logs, browser history and
 * `Referer`. docs/03-API-spec.md §1 answers that with a credential worth almost nothing
 * if it leaks: it names one session, lives sixty seconds, and is accepted once.
 *
 * `packages/auth` owns the first two properties, in a pure function. The third is state,
 * and it lives here:
 *
 * ```
 * verify signature and age   →   claim hash(ticket)   →   admit
 *        (pure, packages/auth)        (atomic, single-use.ts)
 * ```
 *
 * **The order is load-bearing.** Claiming before verifying would let an unauthenticated
 * caller fill the replay store with arbitrary strings — a free denial-of-service against
 * memory or Valkey keyspace, reachable by anyone who can reach the socket. Nothing
 * unauthenticated ever reaches the store.
 *
 * **The stored key is a peppered hash, not the ticket**, so the replay store holds no
 * usable credential; and it is the *same* derivation `apps/collab/src/ticket-store.ts`
 * uses, so when P5 moves that store onto Valkey (docs/14 `H-122`) the two sides are
 * already claiming the same key rather than two spellings of it.
 *
 * **Sixty seconds is the product's number, not a constant invented here** — it comes
 * from `WS_TICKET_TTL_SECONDS`, and `expires_in: 60` in the response is rendered from
 * the same value, so the number a client counts down and the number the verifier
 * enforces cannot drift apart.
 */

import type { SessionId } from '@assaybank/contracts';
import {
  type Clock,
  hashToken,
  issueWsTicket,
  verifyWsTicket,
  WS_TICKET_CLOCK_SKEW_SECONDS,
  WS_TICKET_TTL_SECONDS,
  type WsTicket,
} from '@assaybank/auth';

import { refuse, REASON_FROM_AUTH, type Refusal } from './refusal.js';
import type { SingleUseStore } from './single-use.js';

/**
 * How long a claim is remembered: the ticket's whole accepted life plus the skew the
 * verifier tolerates on `issued_at`.
 *
 * One second longer than the window in which a replay could have succeeded, and not one
 * second longer than that. After it, the signature refuses the ticket on its own and
 * remembering it buys nothing.
 */
export const TICKET_REPLAY_RETENTION_MS =
  (WS_TICKET_TTL_SECONDS + WS_TICKET_CLOCK_SKEW_SECONDS) * 1000;

/** The response body of `POST /sessions/{id}/ticket` (docs/03 §1). */
export interface IssuedWsTicket {
  /** The opaque ticket. Goes in the WebSocket URL; never stored by this service. */
  readonly ticket: string;
  /** Seconds of life, for the client's own retry logic. Always {@link WS_TICKET_TTL_SECONDS}. */
  readonly expiresIn: number;
}

/** Either the session a ticket admits the holder to, or why it was refused. */
export type TicketClaim =
  | { readonly ok: true; readonly ticket: WsTicket }
  | { readonly ok: false; readonly refusal: Refusal };

/** Mints and spends tickets. One instance per process; it holds the key and the store. */
export interface WsTicketService {
  /** Mints a ticket for one session, dated from the injected clock. */
  issue(sessionId: SessionId): IssuedWsTicket;
  /**
   * Verifies a ticket and claims its single use.
   *
   * Returns `ok` exactly once per ticket string. A second presentation — a copied URL, a
   * second tab, the observer of docs/14 `T-013` — is refused with `replayed`.
   */
  claim(ticket: string): Promise<TicketClaim>;
}

/** What {@link createWsTicketService} needs. */
export interface WsTicketServiceOptions {
  /** The ticket signing key. Derived per surface — see `keys.ts`. */
  readonly signingKey: string;
  /** `TOKEN_PEPPER`. Keys the replay entry so the store holds no credential. */
  readonly pepper: string;
  /** Injected, never `Date.now()`: the sixty seconds must be assertable (ADR-006). */
  readonly clock: Clock;
  /** Where single use is enforced. Valkey in a deployed tier. */
  readonly store: SingleUseStore;
}

/** Builds the service. */
export function createWsTicketService(options: WsTicketServiceOptions): WsTicketService {
  const { signingKey, pepper, clock, store } = options;

  return {
    issue(sessionId: SessionId): IssuedWsTicket {
      return {
        ticket: issueWsTicket(sessionId, signingKey, clock),
        expiresIn: WS_TICKET_TTL_SECONDS,
      };
    },

    async claim(ticket: string): Promise<TicketClaim> {
      // 1. Authenticate. Nothing below this line runs on unverified bytes, and nothing
      //    unverified reaches the replay store.
      const verified = verifyWsTicket(ticket, signingKey, clock);
      if (!verified.ok) {
        return {
          ok: false,
          refusal: refuse('ws_ticket', REASON_FROM_AUTH[verified.error.reason]),
        };
      }

      // 2. Spend. One atomic check-and-set; the loser of a race is refused, not admitted.
      const outcome = await store.claim(hashToken(ticket, pepper), TICKET_REPLAY_RETENTION_MS);
      if (outcome === 'replayed') {
        return {
          ok: false,
          refusal: refuse('ws_ticket', 'replayed', { session_id: verified.value.sessionId }),
        };
      }

      return { ok: true, ticket: verified.value };
    },
  };
}
