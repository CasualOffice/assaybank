/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single-use half of the WebSocket ticket (docs/03-API-spec.md §1, P0 step 10).
 *
 * A signature cannot notice that it has been seen before; only state can. `verifyWsTicket`
 * is pure and says so in its own documentation, so "accepted once" is this file's job:
 * the first presentation of a ticket claims it, and every later presentation of the same
 * ticket is refused for as long as that ticket could still have verified.
 *
 * **What is stored is a hash, not the ticket.** The key is `hashToken(ticket, pepper)`,
 * so a heap dump of this process yields no usable credential — and the ticket is a
 * credential that travels in a URL, which is precisely why it must be cheap to lose.
 *
 * **Retention is bounded by the ticket's own life.** An entry is kept for the ticket TTL
 * plus the clock skew the verifier tolerates. After that the signature has expired on its
 * own and remembering it adds nothing but memory, so entries are dropped — a store that
 * grew forever would be a denial-of-service surface reachable by anyone able to ask for
 * tickets.
 *
 * **This is in-memory, and that is a P0 decision with a P5 expiry date.** One instance
 * refusing a replay is the whole guarantee here; with two instances behind a load
 * balancer, a ticket redeemed on instance A can still be redeemed on instance B. P5 moves
 * this set into Valkey (`SET key NX PX <ttl>`, the same atomic claim, shared) alongside the
 * awareness fan-out that already needs Valkey — see CODE-GRAPH.md `collab` → `valkey`.
 * Until then, the collaboration tier runs single-instance, which is also what the
 * in-memory Yjs documents require.
 */

import {
  type Clock,
  hashToken,
  WS_TICKET_CLOCK_SKEW_SECONDS,
  WS_TICKET_TTL_SECONDS,
} from '@assaybank/auth';

/**
 * How long a redeemed ticket is remembered: its whole accepted life, plus the skew the
 * verifier tolerates on `issued_at`. One second longer than the window in which a replay
 * could have succeeded, and not one second longer than that.
 */
export const REPLAY_RETENTION_MS = (WS_TICKET_TTL_SECONDS + WS_TICKET_CLOCK_SKEW_SECONDS) * 1000;

/** Entries are swept in batches rather than per key; this is how often. */
const SWEEP_INTERVAL_MS = 10_000;

/** What {@link TicketStore.claim} decided. */
export type ClaimOutcome = 'claimed' | 'replayed';

/** Options for {@link TicketStore}. */
export interface TicketStoreOptions {
  /** `TOKEN_PEPPER`. The stored key is a peppered hash so that it is not a credential. */
  readonly pepper: string;
  /** Injected, never `Date.now()` — expiry has to be a deterministic assertion (ADR-006). */
  readonly clock: Clock;
  /** Override for tests. Defaults to {@link REPLAY_RETENTION_MS}. */
  readonly retentionMs?: number | undefined;
}

/**
 * The redeemed-ticket set.
 *
 * `claim` is the only way in, and it is a check-and-set rather than a `has` followed by
 * an `add`: two upgrades racing for one ticket must not both win, and on a single
 * event-loop turn an atomic method is the thing that guarantees it.
 */
export class TicketStore {
  /** hash → the instant the entry may be forgotten. */
  private readonly redeemed = new Map<string, number>();

  private readonly pepper: string;
  private readonly clock: Clock;
  private readonly retentionMs: number;
  private lastSweep = 0;

  public constructor(options: TicketStoreOptions) {
    this.pepper = options.pepper;
    this.clock = options.clock;
    this.retentionMs = options.retentionMs ?? REPLAY_RETENTION_MS;
  }

  /**
   * Claims `ticket` for its one permitted use.
   *
   * Returns `claimed` exactly once per ticket string and `replayed` every time after
   * that. Call it only on a ticket whose signature has already verified: claiming first
   * would let an unauthenticated caller fill this map with arbitrary strings.
   */
  public claim(ticket: string): ClaimOutcome {
    const now = this.clock.now().getTime();
    this.sweep(now);

    const key = hashToken(ticket, this.pepper);
    const expiresAt = this.redeemed.get(key);

    if (expiresAt !== undefined && expiresAt > now) {
      return 'replayed';
    }

    this.redeemed.set(key, now + this.retentionMs);
    return 'claimed';
  }

  /** How many redemptions are currently remembered. For the gauge and for the tests. */
  public get size(): number {
    return this.redeemed.size;
  }

  /**
   * The stored keys.
   *
   * Safe to expose, and exposed deliberately: every one of them is a peppered hash rather
   * than a ticket, which is the property this store is built around and which a test
   * asserts through this accessor.
   */
  public get keys(): readonly string[] {
    return [...this.redeemed.keys()];
  }

  /** Drops every entry. Used when the service shuts down, and by tests. */
  public clear(): void {
    this.redeemed.clear();
    this.lastSweep = 0;
  }

  /**
   * Forgets entries whose tickets can no longer verify.
   *
   * Amortised: it runs at most once per {@link SWEEP_INTERVAL_MS} rather than on every
   * claim, and it is driven by the injected clock rather than by a timer, so an idle
   * process holds no handle open and a test can drive expiry by moving the clock.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;

    for (const [key, expiresAt] of this.redeemed) {
      if (expiresAt <= now) this.redeemed.delete(key);
    }
  }
}
